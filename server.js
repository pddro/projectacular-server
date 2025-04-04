// server.js - Slack Bot for Bubble.io Integration
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

// Your configuration - using environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const SLACK_BOT_USER_ID = process.env.SLACK_BOT_USER_ID || 'U08M4BT9VEU'; // Your bot's user ID

// Check for any production/live environment indicator
// This handles multiple possible environment variable formats
const ENV = (process.env.NODE_ENV || '').toLowerCase();
const IS_PRODUCTION = ENV === 'production' || 
                      ENV === 'live' || 
                      process.env.ENVIRONMENT === 'PRODUCTION' || 
                      process.env.ENVIRONMENT === 'LIVE';

console.log(`Running in ${IS_PRODUCTION ? 'PRODUCTION' : 'DEVELOPMENT'} mode`);

// IMPORTANT: Hardcoded full URL to the correct endpoint
const BUBBLE_API_URL = 'https://projectacular.bubbleapps.io/version-test/api/1.1/wf/slack_message/initialize';

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
  
  // Extract team/workspace ID
  const teamId = req.body.team_id;
  console.log(`Received event from team/workspace ID: ${teamId || 'Unknown'}`);
  
  // Log the event for debugging
  console.log("Received event:", event.type);
  
  try {
    // Handle app_mention events (when someone @mentions the bot in a channel)
    if (event.type === 'app_mention') {
      handleBotMention(event, teamId);
    }
    // Handle direct messages to the bot
    else if (event.type === 'message' && event.channel_type === 'im') {
      // Ignore messages from the bot itself to prevent loops
      if (event.bot_id) {
        return;
      }
      handleDirectMessage(event, teamId);
    }
  } catch (error) {
    console.error('Error handling event:', error);
  }
});

// Function to handle when the bot is mentioned in a channel
async function handleBotMention(event, teamId) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  const thread_ts = event.thread_ts || event.ts;
  
  console.log(`Raw message from Slack: "${text}"`);
  console.log(`Message from team/workspace: ${teamId}`);
  
  // Use the bot's user ID from our configuration
  const botUserId = SLACK_BOT_USER_ID;
  console.log(`Bot User ID: ${botUserId}`);
  
  // Extract all user mentions from the message
  const allMentions = [];
  const mentionRegex = /<@([A-Z0-9]+)>/g;
  let match;
  
  // Find all mentions in the message
  while ((match = mentionRegex.exec(text)) !== null) {
    allMentions.push({
      id: match[1],
      fullMatch: match[0],
      index: match.index
    });
  }
  
  console.log(`Found ${allMentions.length} total mentions in message`);
  
  // Create a copy of the message that we'll modify
  let messageWithoutBotMention = text;
  
  // Remove the bot mention from the message
  const botMention = allMentions.find(mention => mention.id === botUserId);
  if (botMention) {
    messageWithoutBotMention = messageWithoutBotMention.replace(botMention.fullMatch, '').trim();
    console.log(`Removed bot mention. Message now: "${messageWithoutBotMention}"`);
  } else {
    console.log(`Warning: Could not find bot mention with ID ${botUserId} in the message`);
    // Continue anyway as this might be a DM or other type of message
  }
  
  // Now extract all user mentions (except the bot)
  const mentionedUsers = [];
  
  // Process all mentions except the bot
  for (const mention of allMentions) {
    if (mention.id !== botUserId) {
      console.log(`Processing mentioned user: ${mention.id}`);
      try {
        // Get user info from Slack
        const userInfo = await getSlackUserInfo(mention.id);
        if (userInfo) {
          const userName = userInfo.real_name || userInfo.name || mention.id;
          const userDisplayName = userInfo.profile && userInfo.profile.display_name 
            ? userInfo.profile.display_name 
            : userName;
            
          console.log(`User info retrieved: ${userName} (Display name: ${userDisplayName})`);
          
          mentionedUsers.push({
            id: mention.id,
            name: userName,
            display_name: userDisplayName,
            username: userInfo.name || ''
          });
        } else {
          console.log(`No user info found for ID: ${mention.id}`);
          mentionedUsers.push({ id: mention.id, name: mention.id });
        }
      } catch (error) {
        console.error(`Error getting info for user ${mention.id}:`, error.message);
        mentionedUsers.push({ id: mention.id, name: mention.id });
      }
    }
  }
  
  console.log(`Forwarding message with ${mentionedUsers.length} mentioned users:`, JSON.stringify(mentionedUsers));
  
  // Send the raw message to Bubble along with the structured mentioned users
  // This lets Claude see all the mentions in their raw format
  await forwardMessageToBubble(messageWithoutBotMention, userId, channelId, thread_ts, mentionedUsers, teamId);
}

// Function to handle direct messages to the bot
async function handleDirectMessage(event, teamId) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  const thread_ts = event.thread_ts || event.ts; // Use thread_ts if it exists, otherwise use ts
  
  console.log(`Received DM: "${text}" from user ${userId} in channel ${channelId}`);
  console.log(`Message from team/workspace: ${teamId}`);
  
  // Forward the entire message to Bubble
  await forwardMessageToBubble(text, userId, channelId, thread_ts, [], teamId);
}

// Forward message to Bubble and handle response
async function forwardMessageToBubble(messageContent, userId, channelId, thread_ts, mentionedUsers = [], teamId) {
  try {
    console.log(`Forwarding message to Bubble: "${messageContent}"`);
    console.log(`Message sender: ${userId}`);
    console.log(`Message channel: ${channelId}`);
    console.log(`Thread timestamp: ${thread_ts || 'none'}`);
    console.log(`Team/Workspace ID: ${teamId}`);
    console.log(`Mentioned users: ${JSON.stringify(mentionedUsers)}`);
    
    // Get user information to include with the message
    const userInfo = await getSlackUserInfo(userId);
    const userName = userInfo ? userInfo.real_name || userInfo.name : userId;
    console.log(`Sender name: ${userName}`);
    
    // Get workspace/team information
    let teamName = null;
    let teamInfo = null;
    if (teamId) {
      teamInfo = await getSlackTeamInfo(teamId);
      teamName = teamInfo ? teamInfo.name : null;
      console.log(`Team name: ${teamName || 'Unknown'}`);
    }
    
    // Prepare data for Bubble
    const messageData = {
      message: messageContent,
      user_id: userId,
      user_name: userName,
      channel_id: channelId,
      thread_ts: thread_ts,
      mentioned_users: mentionedUsers, // Include the mentioned users array
      team_id: teamId, // Include the team/workspace ID
      team_name: teamName, // Include the team/workspace name
      team_icon: teamInfo && teamInfo.icon ? teamInfo.icon : null // Include team icon URLs
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

// New helper function to get Slack team/workspace information
async function getSlackTeamInfo(teamId) {
  try {
    console.log(`Fetching team info for Slack team ID: ${teamId}`);
    
    // Check if SLACK_BOT_TOKEN is set
    if (!SLACK_BOT_TOKEN) {
      console.error('SLACK_BOT_TOKEN is not set. Cannot fetch team info.');
      return null;
    }
    
    const endpoint = `https://slack.com/api/team.info?team=${teamId}`;
    console.log(`Calling Slack API: ${endpoint}`);
    
    const response = await axios.get(endpoint, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
      }
    });
    
    console.log(`Slack API response status: ${response.status}`);
    
    if (response.data && response.data.ok && response.data.team) {
      console.log(`Team info found: ${response.data.team.name} (${response.data.team.id})`);
      
      // Log team icons for debugging
      if (response.data.team.icon) {
        console.log('Team icons found:');
        if (response.data.team.icon.image_34) console.log(`- Icon 34px: ${response.data.team.icon.image_34}`);
        if (response.data.team.icon.image_44) console.log(`- Icon 44px: ${response.data.team.icon.image_44}`);
        if (response.data.team.icon.image_68) console.log(`- Icon 68px: ${response.data.team.icon.image_68}`);
        if (response.data.team.icon.image_88) console.log(`- Icon 88px: ${response.data.team.icon.image_88}`);
        if (response.data.team.icon.image_102) console.log(`- Icon 102px: ${response.data.team.icon.image_102}`);
        if (response.data.team.icon.image_132) console.log(`- Icon 132px: ${response.data.team.icon.image_132}`);
        if (response.data.team.icon.image_230) console.log(`- Icon 230px: ${response.data.team.icon.image_230}`);
        if (response.data.team.icon.image_original) console.log(`- Original icon: ${response.data.team.icon.image_original}`);
      } else {
        console.log('No team icons found');
      }
      
      return response.data.team;
    } else {
      console.error('Failed to get team info:', response.data.error || 'Unknown error');
      return null;
    }
  } catch (error) {
    console.error('Error fetching team info from Slack API:', error.message);
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

// New endpoint for OAuth redirect to capture workspace info during installation
app.get('/slack/oauth_redirect', async (req, res) => {
  const code = req.query.code;
  
  if (!code) {
    return res.status(400).send('Missing code parameter');
  }
  
  try {
    // Exchange code for access token
    const response = await axios.post('https://slack.com/api/oauth.v2.access', null, {
      params: {
        client_id: process.env.SLACK_CLIENT_ID,
        client_secret: process.env.SLACK_CLIENT_SECRET,
        code: code,
        redirect_uri: process.env.SLACK_REDIRECT_URI
      }
    });
    
    if (!response.data.ok) {
      console.error('OAuth error:', response.data.error);
      return res.status(500).send(`Authentication failed: ${response.data.error}`);
    }
    
    // Extract important information
    const teamId = response.data.team.id;
    const teamName = response.data.team.name;
    const userId = response.data.authed_user.id;
    const botToken = response.data.access_token;
    
    console.log(`OAuth successful for team: ${teamName} (${teamId}), user: ${userId}`);
    
    // Get team icon information
    const teamInfo = await getSlackTeamInfo(teamId);
    const teamIcon = teamInfo && teamInfo.icon ? teamInfo.icon : null;
    
    if (teamIcon) {
      console.log('Successfully retrieved team icon information');
    } else {
      console.log('No team icon information available');
    }
    
    // Forward this information to Bubble
    try {
      await axios.post('https://projectacular.bubbleapps.io/version-test/api/1.1/wf/slack_oauth', {
        team_id: teamId,
        team_name: teamName,
        user_id: userId,
        bot_token: botToken, // You'll want to securely store this
        team_icon: teamIcon  // Add the team icon information
      }, {
        headers: {
          'Authorization': `Bearer ${BUBBLE_API_KEY}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('OAuth data successfully sent to Bubble');
      
      // Redirect to success page
      return res.redirect('https://projectacular.bubbleapps.io/version-test/slack/success');
    } catch (bubbleError) {
      console.error('Error sending OAuth data to Bubble:', bubbleError);
      return res.status(500).send('Error connecting your Slack workspace to Projectacular');
    }
  } catch (error) {
    console.error('OAuth process error:', error);
    return res.status(500).send('Authentication process failed');
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
