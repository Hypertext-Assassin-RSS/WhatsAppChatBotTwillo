const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

require("dotenv").config();

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

// save user session 
const userSessions = {};

// get user session
function getUserSession(from) {
    if (!userSessions[from]) {
        userSessions[from] = { step: "greeting" };
    }
    return userSessions[from];
}

app.post("/whatsapp-webhook", (req, res) => {
    const incomingMsg = req.body.Body.trim();
    const from = req.body.From;

   
    const session = getUserSession(from);
    let responseMessage;


    switch (session.step) {
        case "greeting":
            responseMessage = "Welcome! What's your name?";
            session.step = "getName"; 
            break;
        
        case "getName":
            session.name = incomingMsg;
            responseMessage = `Nice to meet you, ${session.name}! Please select your language:\n1) English\n2) Sinhala\n3) Tamil`;
            session.step = "selectLanguage";
            break;

        case "selectLanguage":
            if (["1", "2", "3"].includes(incomingMsg)) {
                
                session.language = incomingMsg === "1" ? "English" : incomingMsg === "2" ? "Sinhala" : "Tamil";
                
                responseMessage = `You selected ${session.language}. Now, please choose an option:\n1) Admissions\n2) Courses\n3) Fees`;
                session.step = "mainMenu";
            } else {
                responseMessage = "Invalid choice. Please reply with 1, 2, or 3 to select your language.";
            }
            break;

        case "mainMenu":
            if (incomingMsg === "1") {
                responseMessage = "You selected Admissions. How can we assist you with Admissions?";
            } else if (incomingMsg === "2") {
                responseMessage = "You selected Courses. What information about Courses would you like to know?";
            } else if (incomingMsg === "3") {
                responseMessage = "You selected Fees. Please specify which course's fees you'd like to inquire about.";
            } else {
                responseMessage = "Invalid choice. Please reply with 1, 2, or 3 to continue.";
            }
            break;

        default:
            responseMessage = "An error occurred. Please start again.";
            session.step = "greeting";
            break;
    }

    // Send response to user
    client.messages.create({
        body: responseMessage,
        from: process.env.TWILIO_WHATSAPP_NUMBER,
        to: from,
    })
    .then((message) => console.log(`Message sent: ${message.sid}`))
    .catch((error) => console.error(error));

    console.log(`User: ${from}, Message: ${incomingMsg}, Step: ${session.step}`);
    res.status(200).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
