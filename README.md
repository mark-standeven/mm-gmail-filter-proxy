# Gmail Filter Proxy

This is a minimal Express.js server designed to receive Gmail Pub/Sub push notifications, decode the payload, and forward valid messages to another webhook endpoint.

## Features

- Handles POST requests from Gmail Pub/Sub
- Decodes base64-encoded message data
- Forwards payload to a user-defined URL via `FORWARD_WEBHOOK_URL` environment variable

## Setup

1. Install dependencies:

```
npm install
```

2. Create a `.env` file and define:

```
FORWARD_WEBHOOK_URL=https://example.com/webhook/your-endpoint
```

3. Start the server:

```
node index.js
```

## Deployment

You can deploy this to platforms like Render or Railway.  
Make sure to set the `FORWARD_WEBHOOK_URL` environment variable in the platform's dashboard.
