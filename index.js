require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

app.post('/', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.data) {
      console.error('No message data received');
      return res.status(400).send('Bad Request');
    }

    const decoded = Buffer.from(message.data, 'base64').toString();
    const payload = JSON.parse(decoded);

    console.log('Decoded Gmail payload:', payload);

    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('Missing N8N_WEBHOOK_URL');
      return res.status(500).send('Missing webhook URL');
    }

    await axios.post(webhookUrl, payload);
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling Gmail push:', err);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Gmail filter proxy listening on port ${PORT}`);
});
