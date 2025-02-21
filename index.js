const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const { Pool } = require("pg");
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { GoogleAuth } = require('google-auth-library');


const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
let courseID;


const userSessions = {};

const pool = new Pool({
    connectionString: process.env.CONNECTION_STRING
});

const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const SPREADSHEET_ID = '1ZHBwc-T3HSbuVDoBz05ACV7UQeAm5YuHrRYyXxUyNcY';
const SPREADSHEET_ID_WRITABLE = '1kgKVpRp1ge1jqKFSnUSc2-dB9shY9ENoW4fjNsMAidc';
const RANGE = 'Sheet1!A:I';

(async () => {
    try {
        const client = await pool.connect();
        console.log("Connected to PostgreSQL database successfully!");
        client.release();
    } catch (err) {
        console.error("Error connecting to PostgreSQL database:", err);
    }
})();


const checkGroupEnrollId = async (enrollId) => {
    console.log('Checking group enroll_id:', enrollId);

    try {

        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        const rows = response.data.values;
        if (!rows || rows.length === 0) {
            console.log('No data found in the Google Sheet.');
            return { exists: false };
        }

        for (const row of rows) { 
            if (row[0] === enrollId) {
                const courseName = row[1];
                const groupLink = row[7];
                console.log('Group Enroll_id exists:', enrollId);
                return { exists: true, course: { course_name: courseName, group_link: groupLink } };
            }
        }
        console.log('Group Enroll_id does not exist:', enrollId);
        return { exists: false };
    } catch (err) {
        console.error("Error checking enroll_id in Google Sheet:", err);
        throw err;
    }
};


const saveConversationToExel = async (userId, conversationJson) => {
    console.log('Saving conversation to Google Sheet:', conversationJson);

    try {

        const authClient = await auth.getClient();
        google.options({ auth: authClient });

        const values = [
            [userId, conversationJson, new Date().toISOString()]
        ];

        const resource = {
            values,
        };

        const result = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID_WRITABLE,
            range: RANGE,
            valueInputOption: 'RAW',
            resource,
        });

        console.log(`${result.data.updates.updatedCells} cells appended.`);
        return true;
    } catch (err) {
        console.error("Error checking enroll_id in Google Sheet:", err);
        throw err;
    }
};

async function saveConversation(userId, conversationJson) {
    const query = `
        INSERT INTO bot_conversations (user_id, message, timestamp)
        VALUES ($1, $2, now() AT TIME ZONE 'Asia/Colombo');
    `;
    const values = [userId, conversationJson];
    try {
        await pool.query(query, values);
    } catch (err) {
        console.error("Error saving conversation:", err);
    }
}

function formatWhatsAppNumber(input) {
    const match = input.match(/whatsapp:\+94(\d+)/);
    if (match) {
        return '0' + match[1];
    } else {
        throw new Error('Invalid WhatsApp number format');
    }
}

function getUserSession(from) {
    if (!userSessions[from]) {
        userSessions[from] = { step: "greeting", conversation: [] };
    }
    return userSessions[from];
}

function withTimeout(promise, timeoutMs) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
    ]);
}

const checkUserInMoodle = async (username, timeoutMs = 5000) => {
    console.log('Checking user in Moodle:', username);

    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const functionName = 'core_user_get_users';
    const restFormat = 'json';

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('criteria[0][key]', 'username');
        params.append('criteria[0][value]', username);

        const response = await withTimeout(
            axios.post(serverUrl, params.toString(), {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }),
            timeoutMs
        );

        console.log('User exists in Moodle:', response.data);
        const users = response.data.users;
        return users && users.length > 0 ? users[0] : null;
    } catch (err) {
        if (err.message === 'Timeout') {
            console.error(`Timeout checking user in Moodle for username ${username}`);
        } else {
            console.error(`Error checking user in Moodle for username ${username}:`, err.response?.data || err);
        }
        return [];
    }
};

// Sync user to Moodle
const syncUserToMoodle = async (user) => {
    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const functionName = 'core_user_create_users';
    const restFormat = 'json';

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('users[0][username]', user.mobileNo);
        params.append('users[0][email]', `${user.mobileNo}@whatsapp.com`);
        params.append('users[0][firstname]', user.firstName);
        params.append('users[0][lastname]', user.lastName);
        params.append('users[0][password]', user.mobileNo);
        
        // Custom fields
        params.append('users[0][customfields][0][type]', 'Mobile');
        params.append('users[0][customfields][0][value]', user.mobileNo);
        params.append('users[0][customfields][1][type]', 'Class');
        params.append('users[0][customfields][1][value]', user.className);
        params.append('users[0][customfields][2][type]', 'Phone');
        params.append('users[0][customfields][2][value]', user.phone);
        params.append('users[0][customfields][3][type]', 'Grade');
        params.append('users[0][customfields][3][value]', user.grade);

        params.append('users[0][auth]', 'manual');

        const response = await axios.post(serverUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        console.log('User synced to Moodle:', response.data);
        return response.data[0];
    } catch (err) {
        console.error('Error syncing user to Moodle:', err.response?.data || err);
        throw err;
    }
};

const enrollUserToMoodleCourse = async (username, courseId) => {
    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const functionName = 'enrol_manual_enrol_users';
    const restFormat = 'json';

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('enrolments[0][roleid]', 5);
        params.append('enrolments[0][userid]', username);
        params.append('enrolments[0][courseid]', courseId);

        const response = await axios.post(serverUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        console.log('User enrolled in course:',courseId);
        return true;
    } catch (err) {
        console.error('Error enrolling user in Moodle course:', err.response?.data || err);
        throw err;
    }
};


const sendDelayedMessage = (to, message, delay) => {
    setTimeout(() => {
        client.messages
            .create({
                body: message,
                from: process.env.TWILIO_WHATSAPP_NUMBER,
                to: to,
                mediaUrl : ['https://bucket-ebooks.s3.us-east-1.amazonaws.com/whatsapp-bot/WhatsApp%20Image%202025-01-17%20at%2009.32.20_5f09545c.jpg']
                
            })
            .then((message) => console.log(`Delayed message sent: ${message.sid}`))
            .catch((error) => console.error(error));
    }, delay);
};

const enrollmentLock = {};

const acquireLock = (from) => {
    return new Promise((resolve, reject) => {
        const checkLock = () => {
            if (!enrollmentLock[from]) {
                enrollmentLock[from] = true;
                resolve();
            } else {
                setTimeout(checkLock, 100);
            }
        };
        checkLock();
    });
};

const releaseLock = (from) => {
    delete enrollmentLock[from];
};


const checkEnrollId = async (enrollId) => {
    console.log('Checking enroll_id:', enrollId);

    try {
        const query = `
            SELECT * FROM public.moodle_courses WHERE enroll_id = $1;
        `;
        const values = [enrollId];
        const result = await pool.query(query, values);

        if (result.rows.length > 0) {
            console.log('Enroll_id exists:', enrollId);
            const course = result.rows[0];
            let courseIds = [course.course_id];

            if (course.course_id.toString().length > 2) {
                const courseIdStr = course.course_id.toString();
                courseIds = [parseInt(courseIdStr.slice(0, 2)), parseInt(courseIdStr.slice(2))];
            }

            return { exists: true, course, courseIds };
        } else {
            console.log('Enroll_id does not exist:', enrollId);
            return { exists: false };
        }
    } catch (err) {
        console.error("Error checking enroll_id:", err);
        throw err;
    }
};

app.post("/whatsapp-webhook", async (req, res) => {
    let enrollment;
    let groupEnrollment;

    const incomingMsg = req.body?.Body?.replace(/[^a-zA-Z0-9]/g, '');

    console.log("Incoming message:", incomingMsg);

    const from = req.body.From;

    const session = getUserSession(from);

    session.conversation.push({ direction: 'incoming', message: incomingMsg });

    let responseMessage;
    let responseMedia = null;

    await acquireLock(from);

    const existingUser = await checkUserInMoodle(formatWhatsAppNumber(from));

    if (incomingMsg === '25010003') {
        if (existingUser) {
            console.log('User exists in Moodle:', existingUser.username);
            console.log('User custom fields:', existingUser.customfields[3].value);

            const userGrade = existingUser.customfields[3].value.charAt(existingUser.customfields[3].value.length - 1);

            switch (userGrade) {
                case '3':
                    await enrollUserToMoodleCourse(existingUser.id, 62);
                    await enrollUserToMoodleCourse(existingUser.id, 70);
                    responseMessage = `ඔබ අපගේ 2025 eපාසල Smart-03 ජනවාරි සහ පෙබරවාරි පාඨමාලාව සම්බන්ධ වි ඇත. \nඔබගේ username = ${existingUser.username} \npassword = ${existingUser.username} ලෙස භාවිත කරන්න.`;
                    break;
                case '4':
                    await enrollUserToMoodleCourse(existingUser.id, 58);
                    await enrollUserToMoodleCourse(existingUser.id, 71);
                    responseMessage = `ඔබ අපගේ 2025 eපාසල Smart-04 ජනවාරි සහ පෙබරවාරි පාඨමාලාව සම්බන්ධ වි ඇත. \nඔබගේ username = ${existingUser.username} \npassword = ${existingUser.username} ලෙස භාවිත කරන්න.`;
                    break;
                case '5':
                    await enrollUserToMoodleCourse(existingUser.id, 72);
                    await enrollUserToMoodleCourse(existingUser.id, 68);
                    responseMessage = `ඔබ අපගේ 2025 eපාසල Smart-05 ජනවාරි සහ පෙබරවාරි පාඨමාලාව සම්බන්ධ වි ඇත. \nඔබගේ username = ${existingUser.username} \npassword = ${existingUser.username} ලෙස භාවිත කරන්න.`;
                    break;
                default:
                    responseMessage = `ඔබ අතුලත් කල කේතයේ වැරදී කරුනාකර නැවත නිවැරදි කේතය යොදා send කරන්න නැතහොත් \n තාක්ෂණික සහය සඳහා 📞0760991306 \n විස්තර දැනගැනීම සඳහා 📞 0768288636 ,  අමතන්න.`;
                    break;
            }

            session.step = "greeting";

        } else {
            responseMessage = "කරුනා කර ඔබගේ ශ්‍රේණිය අතුලත් කරන්න, උදා :- 4  ශ්‍රේණිය  නම් අංක 4 යොදා send කරන්න.";
            session.step = "getGrade";
        }
    } else {
        switch (session.step) {
            case "getGrade":
                const grade = parseInt(incomingMsg);
                if (!isNaN(grade) && grade >= 3 && grade <= 5) {
                    session.grade = grade;
                    responseMessage = "Welcome! සමනල දැනුම ආයතනය ඔබව සාදරයෙන් පිළිගනී 🙏. පාඨමාලාව සඳහා ඔබව ඇතුලත් කරගැනීමට ඔබගේ පළමු නම ( First Name ) ලබාදෙන්න ( ඉංග්‍රීසි අකුරු භාවිත කරන්න ).";
                    session.step = "getFirstName";
                } else {
                    responseMessage = "කරුනා කර ඔබගේ ශ්‍රේණිය අතුලත් කරන්න, උදා :- 4  ශ්‍රේණිය  නම් අංක 4 යොදා send කරන්න";
                    session.step = "getGrade";
                }
                break;
            case "greeting":
                if (/^\d{8}$/.test(incomingMsg)) {
                    enrollment = await checkEnrollId(incomingMsg);
                } else {
                    responseMessage = `ඔබ අතුලත් කල කේතයේ වැරදී කරුනාකර නැවත නිවැරදි කේතය යොදා send කරන්න නැතහොත් \n තාක්ෂණික සහය සඳහා 📞0760991306 \n විස්තර දැනගැනීම සඳහා 📞 0768288636 ,  අමතන්න.`;
                    session.step = "greeting";
                }
                groupEnrollment = await checkGroupEnrollId(incomingMsg);
                if (enrollment?.exists && existingUser) {
                    session.firstName = existingUser.firstname;
                    session.lastName = existingUser.lastname;
                    session.username = existingUser.username;

                    const courseIds = enrollment.courseIds;

                    console.log('LMS Course IDs: ', courseIds);

                    try {
                        for (const courseId of courseIds) {
                            await enrollUserToMoodleCourse(existingUser.id, courseId);
                        }
                        responseMessage = `${session.firstName} ${session.lastName}! ඔබගේ ඇතුලත් වීම සාර්තකයි. \n ඔබ අපගේ "${enrollment.course.course_name}"පාඨමාලාව සම්බන්ඳ වි ඇත.\nඇතුල්විම සඳහා ඔබ අප හා සම්බන්ධ වූ ${session.username} දුරකථන අංකය username හා password ලෙස භාවිත කරන්න.`;
                    } catch (error) {
                        responseMessage = `කනගාටුයි ඇතුලත් වීමේ කේතය නැවත එවා උත්සාහ කරන්න!`;
                    }
                    session.step = "greeting";
                } else if (enrollment?.exists && !existingUser) {
                    const courseIds = enrollment.courseIds;
                    session.courseName = enrollment.course.course_name;
                    session.grade = enrollment.course.grade;
                    session.courseIds = courseIds;

                    responseMessage = `Welcome! සමනල දැනුම ආයතනය ඔබව සාදරයෙන් පිළිගනී 🙏. "${session.courseName}". පාඨමාලාව සඳහා ඔබව ඇතුලත් කරගැනීමට ඔබගේ පළමු නම ( First Name ) ලබාදෙන්න ( ඉංග්‍රීසි අකුරු භාවිත කරන්න ).`;
                    session.step = "getFirstName";
                } else if (groupEnrollment?.exists) {
                    responseMessage = `Welcome To ${groupEnrollment.course.course_name} Course. Please Use ${groupEnrollment.course.group_link} to join the group.`;
                    session.step = "greeting";
                } else {
                    responseMessage = `ඔබ අතුලත් කල කේතයේ වැරදී කරුනාකර නැවත නිවැරදි කේතය යොදා send කරන්න නැතහොත් \n තාක්ෂණික සහය සඳහා 📞0760991306 \n විස්තර දැනගැනීම සඳහා 📞 0768288636 ,  අමතන්න.`;
                    session.step = "greeting";
                }
                break;
            case "getFirstName":
                session.firstName = incomingMsg;
                if (incomingMsg.length <= 3 && /^[A-Za-z]+$/.test(incomingMsg)) {
                    responseMessage = "කරුණාකර ඔබගේ පළමු නම ( First Name ) ලබාදෙන්න.";
                    session.step = "getFirstName";
                } else {
                    responseMessage = `${session.firstName} ඔබගේ වාසගම ( Last Name ) ලබාදෙන්න.`;
                    session.step = "getLastName";
                }
                break;
            case "getLastName":
                session.username = formatWhatsAppNumber(from);
                session.password = formatWhatsAppNumber(from);
                session.lastName = incomingMsg;

                if (incomingMsg.length <= 3 && /^[A-Za-z]+$/.test(incomingMsg)) {
                    responseMessage = "කරුණාකර ඔබගේ ඔබගේ වාසගම ( Last Name ) ලබාදෙන්න.";
                    session.step = "getLastName";
                } else {
                    responseMessage = `කරුණාකර ඔබගේ තොරතුරු තහවුරු කරගන්න :\nනම: ${session.firstName} ${session.lastName}\nUsername: ${session.username}\nසනාථ කිරීම සඳහා අංක 1 ද , නැවත උත්සාහ කිරිමට අංක 2 , ලබාදෙන්න.`;
                    session.step = "confirmDetails";
                }
                break;

            case "confirmDetails":
                if (incomingMsg.toLowerCase() === '1' && incomingMsg === '1') {
                    const newUser = {
                        mobileNo: session.username,
                        firstName: session.firstName,
                        lastName: session.lastName,
                        className: "Class X",
                        grade: session.grade,
                        phone: session.username,
                    };
                    try {
                        const moodleUser = await syncUserToMoodle(newUser);
                        const userId = moodleUser.id;

                        try {
                            let status1, status2;
                            if (session.grade == 3) {
                                status1 = await enrollUserToMoodleCourse(userId, 62);
                                status2 = await enrollUserToMoodleCourse(userId, 70);
                            } else if (session.grade == 4) {
                                status1 = await enrollUserToMoodleCourse(userId, 58);
                                status2 = await enrollUserToMoodleCourse(userId, 71);
                            } else if (session.grade == 5) {
                                status1 = await enrollUserToMoodleCourse(userId, 72);
                                status2 = await enrollUserToMoodleCourse(userId, 68);
                            }

                            console.log('User enrolled in courses:', status1, status2);
                            responseMessage = `ඔබගේ ලියාපදිංචිය සාර්ථකයි!\nඔබ අපගේ 2025 eපාසල Smart-${session.grade} ජනවාරි සහ පෙබරවාරි පාඨමාලාවට සම්බන්ධ  වි ඇත.
                            \n ඇතුල්විම සඳහා ඔබ අප හා සම්බන්ධ වූ '${session.username}'  දුරකථන අංකය username හා password ලෙස භාවිත කරන්න 
                            \Download the app here: https://shorturl.at/hKmI8. 
                            \nඔබට අපගේ App එක Download කරගැනීමට නොහැකිනම් හෝ ඔබ Apple දුරකථනයක් භාවිතා කරන්නේ නම් https://samanalaeschool.lk/ හරහා අප හා සම්බන්ද විය හැක.
    `;
                            // responseMedia = ["https://bucket-ebooks.s3.us-east-1.amazonaws.com/whatsapp-bot/WhatsApp%20Image%202024-11-29%20at%2016.06.50_8f4cf944.jpg"];

                            const delayedMessage = `මෙම e පාසලෙන් ලැබෙන සියලු දැනුම ලබා ගැනීමට ඔබ තවමත් "${session.courseName}" මිල දී ගෙන නැති නම් දැන්ම ඔබගේ ළඟම ඇති අලෙවි නියොජිතගෙන් හෝ පොත් හලෙන්  මිල දී ගන්න නැතහොත් \n විස්තර දැනගැනීම සඳහා 📞 0768288636 , \n තාක්ෂණික සහය සඳහා 📞0760991306 අමතන්න.`;
                            sendDelayedMessage(from, delayedMessage, 10 * 1000);

                        } catch (error) {
                            responseMessage = `Registration successful!`;
                        }
                    } catch (error) {
                        responseMessage = "An error occurred during registration. Please try again.";
                    }
                    session.step = "greeting";
                } else if (incomingMsg.toLowerCase() === '2' && incomingMsg === '2') {
                    responseMessage = "නැවත උත්සහ කරමු. ඔබගේ පළමු නම ( First Name ) ලබාදෙන්න.";
                    session.step = "getFirstName";
                } else {
                    responseMessage = `ලබාදුන් පිළිතුර වැරදි නැවත උත්සහ කරන්න. \nකරුණාකර ඔබගේ තොරතුරු තහවුරු කරගන්න :\nනම: ${session.firstName} ${session.lastName}\nUsername: ${session.username}\nසනාථ් කිරීම සඳහා අංක 1 ද , නැවත උත්සාහ කිරිමට අංක 2 , ලබාදෙන්න.`;
                    session.step = "confirmDetails";
                }
                break;

            default:
                responseMessage = "An error occurred. Please start again.";
                session.step = "greeting";
                break;
        }
    }

    session.conversation.push({ direction: 'outgoing', message: responseMessage });

    const messageOptions = {
        body: responseMessage,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
    };

    if (responseMedia) {
        messageOptions.mediaUrl = responseMedia;
    }

    client.messages
        .create(messageOptions)
        .then((message) => console.log(`Message sent: ${message.sid}`))
        .catch((error) => console.error(error));

    if (session.step === "greeting") {
        await saveConversation(from, JSON.stringify(session.conversation));
        // await saveConversationToExel(from, JSON.stringify(session.conversation));
        delete userSessions[from];
    }

    console.log(`User: ${from}, Message: ${incomingMsg}, Step: ${session.step}`);
    res.status(200).end();

    releaseLock(from);
});

app.get("/conversation/:userId", async (req, res) => {
    const userId = req.params.userId;

    try {
        const query = `
            SELECT * FROM bot_conversations
            WHERE user_id = $1
            ORDER BY timestamp;
        `;
        const values = [userId];
        const result = await pool.query(query, values);

        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching conversation history:", err);
        res.status(500).send("Internal Server Error");
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});