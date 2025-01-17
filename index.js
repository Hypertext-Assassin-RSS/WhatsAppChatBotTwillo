const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const { Pool } = require("pg");
const { google } = require('googleapis');
const sheets = google.sheets('v4');
const { GoogleAuth } = require('google-auth-library');


const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

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
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
});

const SPREADSHEET_ID = '1ZHBwc-T3HSbuVDoBz05ACV7UQeAm5YuHrRYyXxUyNcY';
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
            return { exists: true, course: result.rows[0] };
        } else {
            console.log('Enroll_id does not exist:', enrollId);
            return { exists: false };
        }
    } catch (err) {
        console.error("Error checking enroll_id:", err);
        throw err;
    }
};

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

// Helper function to add timeout
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
        params.append('users[0][customfields][3][value]', 'Grade ' + user.grade);

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

// WhatsApp webhook
app.post("/whatsapp-webhook", async (req, res) => {
    let enrollment;
    let groupEnrollment;

    let trimmedMsg = req.body?.Body?.trim();

    const incomingMsg = trimmedMsg.replace(/[^a-zA-Z0-9]/g, '');

    console.log("Incoming message:", incomingMsg);

    const from = req.body.From;

    const session = getUserSession(from);

    session.conversation.push({ direction: 'incoming', message: incomingMsg });

    let responseMessage;
    let responseMedia = null;

    switch (session.step) {
        case "greeting":
            if (/^\d{8}$/.test(incomingMsg)) {
                enrollment = await checkEnrollId(incomingMsg);
            } else {
                responseMessage = `ආයුබෝවන් 🙏 සමනල දැනුම ආයතනය විස්තර දැනගැනීම සඳහා 📞 0768288636 , \n තාක්ෂණික සහය සඳහා 📞0760991306 අමතන්න.`;
                session.step = "greeting";
            }
            groupEnrollment = await checkGroupEnrollId(incomingMsg);
            const existingUser = await checkUserInMoodle(formatWhatsAppNumber(from));

            if (enrollment?.exists && existingUser) {
                session.firstName = existingUser.firstname;
                session.lastName = existingUser.lastname;
                session.username = existingUser.username;

                courseID = enrollment.course.course_id;

                console.log('LMS Course ID: ', courseID);

                try {
                    await enrollUserToMoodleCourse(existingUser.id, courseID);
                    responseMessage = `${session.firstName} ${session.lastName}! ඔබගේ ඇතුලත් වීම සාර්තකයි. \n ඔබ අපගේ "${enrollment.course.course_name}"පාඨමාලාව සම්බන්ඳ වි ඇත.\nඇතුල්විම සඳහා ඔබ අප හා සම්බන්ධ වූ ${session.username} දුරකථන අංකය username හා password ලෙස භාවිත කරන්න.`;
                } catch (error) {
                    responseMessage = `කනගාටුයි ඇතුලත් වීමේ කේතය නැවත එවා උත්සාහ කරන්න!`;
                }
                session.step = "greeting";
            } else if (enrollment?.exists && !existingUser) {
                courseID = enrollment.course.course_id;
                session.courseName = enrollment.course.course_name;
                session.grade = enrollment.course.grade;

                responseMessage = `Welcome! සමනල දැනුම ආයතනය ඔබව සාදරයෙන් පිළිගනී 🙏. "${session.courseName}". පාඨමාලාව සඳහා ඔබව ඇතුලත් කරගැනීමට ඔබගේ පළමු නම ( First Name ) ලබාදෙන්න ( ඉංග්‍රීසි අකුරු භාවිත කරන්න ).`;
                session.step = "getFirstName";
            } else if (groupEnrollment?.exists) {
                responseMessage = `Welcome To ${groupEnrollment.course.course_name} Course. Please Use ${groupEnrollment.course.group_link} to join the group.`;
                session.step = "greeting";
            } else {
                responseMessage = `ආයුබොවන් 🙏 සමනල දැනුම ආයතනය විස්තර දැනගැනීම සඳහා 📞 0768288636 , \n තාක්ෂණික සහය සඳහා 📞0760991306 අමතන්න.`;
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
                const existingUser = await checkUserInMoodle(session.username);
                if (existingUser) {
                    responseMessage = "You are already registered.";
                } else {
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
                            await enrollUserToMoodleCourse(userId, courseID);
                            responseMessage = `ඔබගේ ලියාපදිංචිය සාර්ථකයි!\nඔබ අපගේ "${session.courseName}" පාඨමාලාවට සම්බන්ධ  වි ඇත.\nDownload the app here: https://shorturl.at/hKmI8. \nඇතුල්විම සඳහා ඔබ අප හා සම්බන්ධ වූ ${session.username} දුරකථන අංකය username හා password ලෙස භාවිත කරන්න \n \n \n \n \t \t
                            මෙම e පාසලෙන් ලැබෙන සියලු දැනුම ලබා ගැනීමට ඔබ තවමත් "${session.courseName}" මිල දී ගෙන නැති නම් දැන්ම ඔබගේ ළඟම ඇති අලෙවි නියොජිතගෙන් හෝ පොත් හලෙන්  මිල දී ගන්න නැතහොත් \n  විස්තර දැනගැනීම සඳහා 📞 0768288636 , \n තාක්ෂණික සහය සඳහා 📞0760991306 අමතන්න.`;
                            // responseMedia = ["https://bucket-ebooks.s3.us-east-1.amazonaws.com/whatsapp-bot/WhatsApp%20Image%202024-11-29%20at%2016.06.50_8f4cf944.jpg"];
                        } catch (error) {
                            responseMessage = `Registration successful!`;
                        }
                    } catch (error) {
                        responseMessage = "An error occurred during registration. Please try again.";
                    }
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
        delete userSessions[from];
    }

    console.log(`User: ${from}, Message: ${incomingMsg}, Step: ${session.step}`);
    res.status(200).end();
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