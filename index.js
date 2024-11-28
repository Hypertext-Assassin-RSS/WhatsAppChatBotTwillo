const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const userSessions = {};


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

// WhatsApp webhook
app.post("/whatsapp-webhook", async (req, res) => {
    const incomingMsg = req.body.Body.trim();
    const from = req.body.From;

    const session = getUserSession(from);
    let responseMessage;
    let responseMedia;

    switch (session.step) {
        case "greeting":
            responseMessage = "Welcome! What's your name?";
            responseMedia = ["https://img.freepik.com/free-vector/stylish-welcome-lettering-banner-opening-new-office_1017-50438.jpg"];
            session.step = "getName";
            break;

        case "getName":
            session.name = incomingMsg;
            responseMessage = `Nice to meet you, ${session.name}! What's your grade?`;
            responseMedia = ["https://i.cbc.ca/1.5721290.1693912253!/fileImage/httpImage/image.JPG_gen/derivatives/16x9_780/back-to-school-wexford-collegiate.JPG"];
            session.step = "getGrade";
            break;

        case "getGrade":
            session.grade = incomingMsg;
            responseMessage = "Please confirm your WhatsApp number (this will be used as your username and password).";
            responseMedia = ["https://www.digitaltrends.com/wp-content/uploads/2022/06/whatsapp-iphone-android-logo-app.jpg?fit=720%2C479&p=1"];
            session.step = "getWhatsAppNumber";
            break;

        case "getWhatsAppNumber":
            session.username = incomingMsg;
            session.password = incomingMsg;
            responseMessage = `Confirm your details:\nName: ${session.name}\nGrade: ${session.grade}\nUsername: ${session.username}\nReply 'yes' to confirm or 'no' to re-enter.`;
            responseMedia = ["https://img.freepik.com/premium-vector/confirm-button_592324-29144.jpg"];
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
                        firstName: session.name.split(" ")[0],
                        lastName: session.name.split(" ").slice(1).join(" ") || "User",
                        className: "Class X",
                        grade: session.grade,
                        phone: session.username
                    };
                    try {
                        await syncUserToMoodle(newUser);
                        responseMessage = `Registration successful!, \nDownload the app here: https://samanalaeschool.lk/app. \nYou can now log in to Samanala eSchool using your WhatsApp number as username and password.`;
                        responseMedia = ["https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQVITQzRf-V8mU6c-dSwCDT96Ib3OoAUVZLXA&s"];
                    } catch (error) {
                        responseMessage = "An error occurred during registration. Please try again.";
                    }
                }
                session.step = "greeting";
            } else {
                responseMessage = "Let's start again. What's your name?";
                session.step = "getName";
            }
            break;

        default:
            responseMessage = "An error occurred. Please start again.";
            session.step = "greeting";
            break;
    }

    client.messages.create({
        body: responseMessage,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
        mediaUrl: responseMedia,
    })
    .then((message) => console.log(`Message sent: ${message.sid}`))
    .catch((error) => console.error(error));

    console.log(`User: ${from}, Message: ${incomingMsg}, Step: ${session.step}`);
    res.status(200).end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
