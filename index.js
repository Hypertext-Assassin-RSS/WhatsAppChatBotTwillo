const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const { Pool } = require("pg");
const qs = require('qs');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);
let courseID;

const userSessions = {};

const pool = new Pool({
    connectionString:process.env.connectionString
});


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
        const query = `SELECT * FROM public.groups WHERE enroll_id = $1;`;
        const values = [enrollId];
        const result = await pool.query(query, values);

        if (result.rows.length > 0) {
            console.log('Group Enroll_id exists:', enrollId);

            return { exists: true, course: result.rows[0] };
        } else {
            console.log('Group Enroll_id does not exist:', enrollId);

            return { exists: false };
        }
    } catch (err) {
        console.error("Error checking enroll_id:", err);
        throw err;
    }
};

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
        userSessions[from] = { step: "greeting" };
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
        params.append('enrolments[0][roleid]', 5); // Role ID 5 is the default for "Student"
        params.append('enrolments[0][userid]', username);
        params.append('enrolments[0][courseid]', courseId);

        const response = await axios.post(serverUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        console.log('User enrolled in course:', response.data);
        return true;
    } catch (err) {
        console.error('Error enrolling user in Moodle course:', err.response?.data || err);
        throw err;
    }
};

// WhatsApp webhook
app.post("/whatsapp-webhook", async (req, res) => {
    const incomingMsg = req.body?.Body?.trim();
    const from = req.body.From;

    const session = getUserSession(from);
    let responseMessage;
    let responseMedia = null;

    switch (session.step) {
        case "greeting":
            const groupEnrollment = await checkGroupEnrollId(incomingMsg);
            const enrollment = await checkEnrollId(incomingMsg);
            const existingUser = await checkUserInMoodle(formatWhatsAppNumber(from));

            if (enrollment.exists && existingUser) {
                session.firstName = existingUser.firstname;
                session.lastName = existingUser.lastname;
                session.username = existingUser.username;

                courseID = enrollment.course.course_id;

                console.log('LMS Course ID: ', courseID);

                try {
                    await enrollUserToMoodleCourse(existingUser.id, courseID);
                    responseMessage = `Hello ${session.firstName} ${session.lastName}! You have been successfully enrolled in the course "${enrollment.course.course_name}".`;
                } catch (error) {
                    responseMessage = `Sorry! Enrollment failed. Please contact support.`;
                }
                session.step = "greeting";
                } else if (enrollment.exists && !existingUser) {
                    courseID = enrollment.course.course_id;
                    session.courseName = enrollment.course.course_name;
                    session.grade = enrollment.course.grade;

                    responseMessage = `Welcome! You are not registered in our system. Let's register you for the course "${session.courseName}". What's your first name?`;
                    session.step = "getFirstName";
                } else if (groupEnrollment.exists) {
                    responseMessage = `Welcome To ${groupEnrollment.course.course_name} Course. Please Use ${groupEnrollment.course.group_link} to join the group.`;
                    session.step = "greeting";
                }
                else {
                    responseMessage = "Enrollment ID not found. Please enter a valid enrollment ID.";
                    session.step = "greeting";
                }
                break;


            case "getFirstName":
                session.firstName = incomingMsg;
                responseMessage = `Nice to meet you, ${session.firstName}! What's your last name?`;
                session.step = "getLastName";
                break;


            case "getLastName":
                session.lastName = incomingMsg;
                responseMessage = `Hello, ${session.firstName} ${session.lastName}! 
                \nPlease Remember ${formatWhatsAppNumber(from)} your WhatsApp number (this will be used as your username and password). \nReply '1' to Continue.`;
                session.step = "getWhatsAppNumber";
                break;
            

            case "getWhatsAppNumber":
                session.username = formatWhatsAppNumber(from);
                session.password = incomingMsg;
                responseMessage = `Confirm your details:\nName: ${session.firstName} ${session.lastName}\nGrade: ${session.grade}\nUsername: ${session.username}\nReply '1' to confirm or '2' to re-enter.`;
                session.step = "confirmDetails";
                break;

            case "confirmDetails":
                if (incomingMsg.toLowerCase() === '1') {
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
                                responseMessage = `Registration and enrollment successful!\nYou have been enrolled in the course "${session.courseName}".\nDownload the app here: https://samanalaeschool.lk/app. You can now log in to Samanala 🦋 eSchool using your WhatsApp number as username and password.`;
                                responseMedia = ["https://bucket-ebooks.s3.us-east-1.amazonaws.com/whatsapp-bot/WhatsApp%20Image%202024-11-29%20at%2016.06.50_8f4cf944.jpg"];
                            } catch (error) {
                                responseMessage = `Registration successful, but enrollment failed. Please contact support.`;
                            }
                        } catch (error) {
                            responseMessage = "An error occurred during registration. Please try again.";
                        }
                    }
                    session.step = "greeting";
                } else {
                    responseMessage = "Let's start again. What's your first name?";
                    session.step = "getFirstName";
                }
                break;
            
        default:
            responseMessage = "An error occurred. Please start again.";
            session.step = "greeting";
            break;
    }

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

    console.log(`User: ${from}, Message: ${incomingMsg}, Step: ${session.step}`);
    res.status(200).end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
