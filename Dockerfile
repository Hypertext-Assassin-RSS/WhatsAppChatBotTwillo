# syntax = docker/dockerfile:1

# Adjust NODE_VERSION as desired
ARG NODE_VERSION=18.18.2
FROM node:${NODE_VERSION}-slim as base

LABEL fly_launch_runtime="Node.js"

# Node.js app lives here
WORKDIR /app

# Set production environment
ENV NODE_ENV="production"

# Define build arguments for environment variables
ARG SESSION_SECRET
ARG TWILIO_ACCOUNT_SID
ARG TWILIO_AUTH_TOKEN
ARG TWILIO_WHATSAPP_NUMBER
ARG MOODLE_URL
ARG MOODLE_TOKEN
ARG CONNECTION_STRING
ARG PORT
ARG GOOGLE_APPLICATION_CREDENTIALS

# Set environment variables from build arguments
ENV SESSION_SECRET=${SESSION_SECRET}
ENV TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID}
ENV TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}
ENV TWILIO_WHATSAPP_NUMBER=${TWILIO_WHATSAPP_NUMBER}
ENV MOODLE_URL=${MOODLE_URL}
ENV MOODLE_TOKEN=${MOODLE_TOKEN}
ENV CONNECTION_STRING=${CONNECTION_STRING}
ENV PORT=${PORT}
ENV GOOGLE_APPLICATION_CREDENTIALS=${GOOGLE_APPLICATION_CREDENTIALS}

# Throw-away build stage to reduce size of final image
FROM base as build

# Install packages needed to build node modules
RUN apt-get update -qq && \
    apt-get install --no-install-recommends -y build-essential node-gyp pkg-config python-is-python3

# Install node modules
COPY package-lock.json package.json ./
RUN npm ci

# Copy application code
COPY . .

# Final stage for app image
FROM base

# Copy built application
COPY --from=build /app /app

# Start the server by default, this can be overwritten at runtime
EXPOSE ${PORT}
CMD [ "node", "index.js" ]