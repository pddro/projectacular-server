// server.js - Slack Bot for Bubble.io Integration
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

// Your configuration - using environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// Check for any production/live environment indicator
// This handles multiple possible environment variable formats
const ENV = (process.env.NODE_ENV || '').toLowerCase();
const IS_PRODUCTION = ENV === 'production' || 
                      ENV === 'live' || 
                      process.env.ENVIRONMENT === 'PRODUCTION' || 
                      process.env.ENVIRONMENT === 'LIVE';

console.log(`Running in ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);

// API URLs based on environment
// You can override this with an environment variable
const BUBBLE_API_URL = process.env.BUBBLE_API_URL || 'https://projectacular.bubbleapps.io/version-test/api/1.1/wf/slack_message';

console.log(`Using Bubble API URL: ${BUBBLE_API_URL}`);

const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || '5f295f248f6872648f79cf0ff089cac0';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Verify Slack requests (simplified for now)
const verifySlackRequest = (req, res, next) => {
  // Implementation of Slack's signing secret verification
  // https://api.slack.com/authentication/verifying-requests-from-slack
  // Note: For production, implement proper request verification here
  next();
};

// Endpoint for Slack events and verification
app.post('/slack/events', (req, res) => {
  // Check if this is a verification request
  if (req.body.type === 'url_verification') {
    // Respond with the challenge token
    console.log("Received verification challenge from Slack");
    return res.json({ challenge: req.body.challenge });
  }
  
  // Respond quickly to acknowledge receipt
  res.status(200).send();
  
  // Process the event (after sending response)
  const event = req.body.event;
  
  // If no event, return early
  if (!event) {
    return;
  }
  
  // Log the event for debugging
  console.log("Received event:", event.type);
  
  try {
    // Handle app_mention events (when someone @mentions the bot in a channel)
    if (event.type === 'app_mention') {
      handleBotMention(event);
    }
    // Handle direct messages to the bot
    else if (event.type === 'message' && event.channel_type === 'im') {
      // Ignore messages from the bot itself to prevent loops
      if (event.bot_id) {
        return;
      }
      handleDirectMessage(event);
    }
  } catch (error) {
    console.error('Error handling event:', error);
  }
});

// Function to handle when the bot is mentioned in a channel
async function handleBotMention(event) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  const thread_ts = event.thread_ts || event.ts; // Use thread_ts if it exists, otherwise use ts
  
  // Parse the command from the message (remove the bot mention part)
  const botMentionMatch = event.text.match(/<@([A-Z0-9]+)>/);
  if (!botMentionMatch) {
    console.log("Could not extract bot user ID from mention");
    return;
  }
  
  const botUserId = botMentionMatch[1];
  // Extract the full message without the bot mention
  const messageContent = text.replace(`<@${botUserId}>`, '').trim();
  
  console.log(`Received mention: "${messageContent}" from user ${userId} in channel ${channelId}`);
  
  // Forward the message to Bubble
  await forwardMessageToBubble(messageContent, userId, channelId, thread_ts);
}

// Function to handle direct messages to the bot
async function handleDirectMessage(event) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  const thread_ts = event.thread_ts || event.ts; // Use thread_ts if it exists, otherwise use ts
  
  console.log(`Received DM: "${text}" from user ${userId} in channel ${channelId}`);
  
  // Forward the entire message to Bubble
  await forwardMessageToBubble(text, userId, channelId, thread_ts);
}

// Forward message to Bubble and handle response
async function forwardMessageToBubble(messageContent, userId, channelId, thread_ts) {
  try {
    console.log(`Forwarding message to Bubble: "${messageContent}"`);
    
    // Get user information to include with the message
    const userInfo = await getSlackUserInfo(userId);
    
    // Prepare data for Bubble
    const messageData = {
      message: messageContent,
      user_id: userId,
      user_name: userInfo ? userInfo.real_name || userInfo.name : userId,
      channel_id: channelId,
      thread_ts: thread_ts
    };
    
    // Log the exact URL and data being sent
    console.log(`Posting to Bubble URL: ${BUBBLE_API_URL}`);
    console.log(`Using API Key: ${BUBBLE_API_KEY.substring(0, 5)}...`);
    
    let response;
    try {
      // First try: Bearer token method
      console.log('Attempting Bearer token authentication...');
      response = await axios.post(BUBBLE_API_URL, messageData, {
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Bubble response successful with Bearer token');
    } catch (authError) {
      console.log('Bearer token auth failed, trying API key in URL...');
      // Second try: API key as query parameter
      response = await axios.post(`${BUBBLE_API_URL}?api_key=${BUBBLE_API_KEY}`, messageData, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      console.log('Bubble response successful with query parameter API key');
    }
    
    console.log('Bubble response:', response.data);
    
    // Check if Bubble returned a response to send back to Slack
    if (response.data && response.data.status === 'success' && response.data.response && response.data.response.response) {
      // Send the response back to Slack
      await sendSlackMessage(channelId, response.data.response.response, thread_ts);
    } else {
      console.log('No response message from Bubble or unexpected response format');
    }
  } catch (error) {
    // Log detailed error information
    console.error('Error forwarding message to Bubble:');
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
      console.error('Response headers:', error.response.headers);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('No response received:', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('Error message:', error.message);
    }
    
    await sendSlackMessage(channelId, `Sorry, there was an error processing your request. Please try again later.`, thread_ts);
  }
}

// Helper function to get Slack user information
async function getSlackUserInfo(userId) {
  try {
    const response = await axios.get(`https://slack.com/api/users.info?user=${userId}`, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      }
    });
    
    if (response.data && response.data.ok && response.data.user) {
      return response.data.user;
    }
    return null;
  } catch (error) {
    console.error('Error fetching user info:', error.message);
    return null;
  }
}

// Helper function to send messages to Slack
async function sendSlackMessage(channelId, text, thread_ts = null) {
  try {
    console.log(`Sending message to channel ${channelId}`);
    
    const messagePayload = {
      channel: channelId,
      text: text
    };
    
    // If thread_ts is provided, add it to the payload to reply in thread
    if (thread_ts) {
      messagePayload.thread_ts = thread_ts;
    }
    
    await axios.post('https://slack.com/api/chat.postMessage', messagePayload, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Message sent successfully');
  } catch (error) {
    console.error('Error sending message to Slack:', error.message);
  }
}

// Function to send a DM to a user
async function sendDirectMessage(userId, text) {
  try {
    console.log(`Opening DM with user ${userId}`);
    
    // First, open a DM channel with the user
    const openResponse = await axios.post('https://slack.com/api/conversations.open', {
      users: userId
    }, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (!openResponse.data.ok) {
      throw new Error(`Failed to open DM: ${openResponse.data.error}`);
    }
    
    const dmChannelId = openResponse.data.channel.id;
    
    // Then send the message to that channel
    await sendSlackMessage(dmChannelId, text);
    
    console.log(`DM sent successfully to user ${userId}`);
  } catch (error) {
    console.error('Error sending DM:', error.message);
  }
}

// Endpoint for Bubble.io to trigger notifications to users
app.post('/bubble/notify', async (req, res) => {
  const { slackUserId, message, thread_ts } = req.body;
  
  if (!slackUserId || !message) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  try {
    if (slackUserId.startsWith('C') || slackUserId.startsWith('G')) {
      // This is a channel ID, not a user ID
      await sendSlackMessage(slackUserId, message, thread_ts);
    } else {
      // This is a user ID, send a DM
      await sendDirectMessage(slackUserId, message);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Simple health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', environment: IS_PRODUCTION ? 'production' : 'development' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT} in ${IS_PRODUCTION ? 'production' : 'development'} mode`);
});
