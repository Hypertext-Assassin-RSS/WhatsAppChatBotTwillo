const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");
const http = require("http");
const { neon } = require("@neondatabase/serverless");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const userSessions = {};
let moodleUser;

const sql = neon(process.env.DATABASE_URL);

const requestHandler = async (req, res) => {
  const result = await sql`SELECT version()`;
  const { version } = result[0];
  res.writeHead(200, { "Content-Type": "text/plain" });
  console.log(version);
  res.end(version);
};



function getUserSession(from) {
    if (!userSessions[from]) {
        userSessions[from] = { step: "greeting" };
    }
    return userSessions[from];
}



// Check if user exists in Moodle
const checkUserInMoodle = async (username) => {
    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const functionName = 'core_user_get_users';
    const restFormat = 'json';

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('criteria[0][key]', 'username');
        params.append('criteria[0][value]', username);

        const response = await axios.post(serverUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        await enrollUserInCourse(response.data[0]);
        console.log(`User ${username} found in Moodle`);
        
        const users = response.data.users;
        return users && users.length > 0 ? users[0] : null;
    } catch (err) {
        console.error(`Error checking user in Moodle for username ${username}:`, err.response?.data || err);
        throw err;
    }
};

// Sync user to Moodle
const syncUserToMoodle = async (user) => {
    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const functionName = 'core_user_create_users';
    const restFormat = 'json';
    const courseID = process.env.COURSE_ID;

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('users[0][username]', user.mobileNo);
        params.append('users[0][email]', `${user.mobileNo}@${courseID}.com`);
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

const enrollUserInCourse = async (user) => {
    const moodleUrl = process.env.MOODLE_URL;
    const moodleToken = process.env.MOODLE_TOKEN;
    const lmscourseId = process.env.COURSE_ID;
    const functionName = 'enrol_manual_enrol_users';
    const restFormat = 'json';

    try {
        const serverUrl = `${moodleUrl}/webservice/rest/server.php?wstoken=${moodleToken}&wsfunction=${functionName}&moodlewsrestformat=${restFormat}`;
        const params = new URLSearchParams();
        params.append('enrolments[0][roleid]', '5');
        params.append('enrolments[0][userid]', user.id);
        params.append('enrolments[0][courseid]', lmscourseId);

        const response = await axios.post(serverUrl, params.toString(), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });

        console.log(`User ${user.username} enrolled in course : ${lmscourseId}`);
        return response.data;
    } catch (err) {
        console.error('Error enrolling user in Moodle course:', err.response?.data || err);
        throw err;
    }
};

// WhatsApp webhook
app.post("/whatsapp-webhook", async (req, res) => {
    const incomingMsg = req.body.Body.trim();
    const from = req.body.From;

    const session = getUserSession(from);
    let responseMessage;
    let responseMedia = null;

    switch (session.step) {
        case "greeting":
            responseMessage = "Welcome! What's your first name?";
            session.step = "getFirstName";
            break;

        case "getFirstName":
            session.firstName = incomingMsg;
            responseMessage = `Nice to meet you, ${session.firstName}! What's your last name?`;
            session.step = "getLastName";
            break;

        case "getLastName":
            session.lastName = incomingMsg;
            responseMessage = `Hello, ${session.firstName} ${session.lastName}! What's your grade?`;
            session.step = "getGrade";
            break;

        case "getGrade":
            session.grade = incomingMsg;
            responseMessage = "Please confirm your WhatsApp number (this will be used as your username and password).";
            session.step = "getWhatsAppNumber";
            break;

        case "getWhatsAppNumber":
            session.username = incomingMsg;
            session.password = incomingMsg;
            responseMessage = `Confirm your details:\nName: ${session.firstName} ${session.lastName}\nGrade: ${session.grade}\nUsername: ${session.username}\nReply 'yes' to confirm or 'no' to re-enter.`;
            session.step = "confirmDetails";
            break;

        case "confirmDetails":
            if (incomingMsg.toLowerCase() === "yes") {
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
                        moodleUser = await syncUserToMoodle(newUser);
                        await enrollUserInCourse(moodleUser);
                        console.log(`User ${session.username} registered successfully`);
                        responseMessage = `Registration successful!\nDownload the app here: https://samanalaeschool.lk/app. \nYou can now log in to Samanala 🦋 eSchool using your WhatsApp number as username and password.`;
                        responseMedia = ["https://bucket-ebooks.s3.us-east-1.amazonaws.com/whatsapp-bot/WhatsApp%20Image%202024-11-29%20at%2016.06.50_8f4cf944.jpg"];
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

app.listen(PORT,  () => {
    console.log(`Server is running on port ${PORT}`);
});

http.createServer(requestHandler).listen(3000, () => {
    console.log("Server running at http://localhost:3000");
  });
