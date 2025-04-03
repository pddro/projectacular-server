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

// IMPORTANT: Hardcoded full URL to the correct endpoint
const BUBBLE_API_URL = 'https://projectacular.bubbleapps.io/version-test/api/1.1/wf/slack_message';

console.log(`Using Bubble API URL: ${BUBBLE_API_URL}`);

const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || '5f295f248f6872648f79cf0ff089cac0';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

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
  const thread_ts = event.thread_ts || event.ts;
  
  console.log(`Raw message from Slack: "${text}"`);
  
  // Find and extract the bot mention
  const botMentionMatch = text.match(/<@([A-Z0-9]+)>/);
  if (!botMentionMatch) {
    console.log("Could not extract bot user ID from mention");
    return;
  }
  
  const botUserId = botMentionMatch[1];
  console.log(`Bot User ID: ${botUserId}`);
  
  // Extract the message without the bot mention
  // This keeps the raw format of other user mentions for Claude to process
  const messageContent = text.replace(`<@${botUserId}>`, '').trim();
  console.log(`Message without bot mention: "${messageContent}"`);
  
  // Extract all mentioned users (except the bot)
  const mentionedUsers = [];
  // This regex will find all user mentions in the format <@USERID>
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  
  // We use a different approach to find all matches
  const matches = [...messageContent.matchAll(mentionRegex)];
  console.log(`Found ${matches.length} user mentions in message`);
  
  for (const match of matches) {
    const mentionedUserId = match[1];
    // Skip the bot itself (although it should already be removed)
    if (mentionedUserId !== botUserId) {
      console.log(`Processing mentioned user: ${mentionedUserId}`);
      try {
        // Get user info from Slack
        const userInfo = await getSlackUserInfo(mentionedUserId);
        if (userInfo) {
          console.log(`User info retrieved: ${userInfo.name || userInfo.real_name || 'Unknown'}`);
          mentionedUsers.push({
            id: mentionedUserId,
            name: userInfo.real_name || userInfo.name || mentionedUserId
          });
        } else {
          console.log(`No user info found for ID: ${mentionedUserId}`);
          mentionedUsers.push({ id: mentionedUserId, name: mentionedUserId });
        }
      } catch (error) {
        console.error(`Error getting info for user ${mentionedUserId}:`, error.message);
        // Still add the user ID even if we can't get their info
        mentionedUsers.push({ id: mentionedUserId, name: mentionedUserId });
      }
    }
  }
  
  console.log(`Forwarding message with ${mentionedUsers.length} mentioned users:`, JSON.stringify(mentionedUsers));
  
  // Pass everything to Bubble - the original message content (with mentions intact) and mentioned users array
  await forwardMessageToBubble(messageContent, userId, channelId, thread_ts, mentionedUsers);
}

// Function to handle direct messages to the bot
async function handleDirectMessage(event) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  const thread_ts = event.thread_ts || event.ts; // Use thread_ts if it exists, otherwise use ts
  
  console.log(`Received DM: "${text}" from user ${userId} in channel ${channelId}`);
  
  // Forward the entire message to Bubble
  await forwardMessageToBubble(text, userId, channelId, thread_ts, []);
}

// Forward message to Bubble and handle response
async function forwardMessageToBubble(messageContent, userId, channelId, thread_ts, mentionedUsers = []) {
  try {
    console.log(`Forwarding message to Bubble: "${messageContent}"`);
    console.log(`Message sender: ${userId}`);
    console.log(`Message channel: ${channelId}`);
    console.log(`Thread timestamp: ${thread_ts || 'none'}`);
    console.log(`Mentioned users: ${JSON.stringify(mentionedUsers)}`);
    
    // Get user information to include with the message
    const userInfo = await getSlackUserInfo(userId);
    const userName = userInfo ? userInfo.real_name || userInfo.name : userId;
    console.log(`Sender name: ${userName}`);
    
    // Prepare data for Bubble
    const messageData = {
      message: messageContent,
      user_id: userId,
      user_name: userName,
      channel_id: channelId,
      thread_ts: thread_ts,
      mentioned_users: mentionedUsers // Include the mentioned users array
    };
    
    // Double check the URL to make sure it's correct
    const fullUrl = 'https://projectacular.bubbleapps.io/version-test/api/1.1/wf/slack_message';
    console.log(`Posting to Bubble URL: ${fullUrl}`);
    console.log(`Using API Key: ${BUBBLE_API_KEY.substring(0, 5)}...`);
    console.log(`Full message data being sent:`, JSON.stringify(messageData, null, 2));
    
    let response;
    
    try {
      // First try: Bearer token method
      console.log('Attempting Bearer token authentication...');
      response = await axios.post(fullUrl, messageData, {
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      console.log('Bubble response successful with Bearer token');
    } catch (authError) {
      console.log('Bearer token auth failed, trying API key in URL...');
      // Log the full error for debugging
      console.error('Auth Error:', authError.message);
      if (authError.response) {
        console.error('Error status:', authError.response.status);
        console.error('Error data:', authError.response.data);
      }
      
      // Second try: API key as query parameter
      response = await axios.post(`${fullUrl}?api_key=${BUBBLE_API_KEY}`, messageData, {
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
    console.log(`Fetching user info for Slack user ID: ${userId}`);
    
    // Check if SLACK_BOT_TOKEN is set
    if (!SLACK_BOT_TOKEN) {
      console.error('SLACK_BOT_TOKEN is not set. Cannot fetch user info.');
      return null;
    }
    
    const endpoint = `https://slack.com/api/users.info?user=${userId}`;
    console.log(`Calling Slack API: ${endpoint}`);
    
    const response = await axios.get(endpoint, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      }
    });
    
    console.log(`Slack API response status: ${response.status}`);
    
    if (response.data && response.data.ok && response.data.user) {
      console.log(`User info found: ${response.data.user.name} (${response.data.user.real_name || 'No real name'})`);
      return response.data.user;
    } else {
      console.error('Failed to get user info:', response.data.error || 'Unknown error');
      return null;
    }
  } catch (error) {
    console.error('Error fetching user info from Slack API:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
      console.error('Response status:', error.response.status);
    }
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
