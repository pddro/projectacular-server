// server.js - Slack Bot for Bubble.io Integration
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

// Your configuration
const SLACK_BOT_TOKEN = 'xoxb-your-token-here';
const BUBBLE_API_URL = 'https://your-bubble-app.bubbleapps.io/api';
const SLACK_SIGNING_SECRET = 'your-slack-signing-secret';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Verify Slack requests 
const verifySlackRequest = (req, res, next) => {
  // Implementation of Slack's signing secret verification
  // https://api.slack.com/authentication/verifying-requests-from-slack
  // Note: For production, implement proper request verification here
  next();
};

// Endpoint for Slack events
app.post('/slack/events', verifySlackRequest, async (req, res) => {
  // Respond quickly to Slack to acknowledge receipt
  res.status(200).send();
  
  const event = req.body.event;
  
  // Handle app_mention events (when someone @mentions the bot)
  if (event && event.type === 'app_mention') {
    try {
      await handleBotMention(event);
    } catch (error) {
      console.error('Error handling mention:', error);
    }
  }
});

// Function to handle when the bot is mentioned
async function handleBotMention(event) {
  // Extract the text after the bot mention
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  
  // Parse the command from the message (remove the bot mention part)
  // This is a simple example - you'll want more sophisticated parsing
  const botUserId = event.text.match(/<@([A-Z0-9]+)>/)[1];
  const command = text.replace(`<@${botUserId}>`, '').trim();
  
  console.log(`Received command: "${command}" from user ${userId} in channel ${channelId}`);
  
  if (command.startsWith('fetch')) {
    // Handle data fetching commands
    await handleFetchCommand(command, channelId);
  } else if (command.startsWith('do')) {
    // Handle action commands
    await handleActionCommand(command, channelId);
  } else {
    // Unknown command
    await sendSlackMessage(channelId, "Sorry, I didn't understand that command. Try 'fetch [data]' or 'do [action]'.");
  }
}

// Handle commands that fetch data from Bubble
async function handleFetchCommand(command, channelId) {
  // Parse what data to fetch (e.g., "fetch users", "fetch tasks", etc.)
  const dataType = command.replace('fetch', '').trim();
  
  try {
    // Call Bubble.io API to get the requested data
    const response = await axios.get(`${BUBBLE_API_URL}/data/${dataType}`, {
      headers: {
        'Authorization': 'Bearer YOUR_BUBBLE_API_TOKEN'
      }
    });
    
    // Format the response data for Slack
    const formattedData = formatBubbleData(response.data, dataType);
    
    // Send the formatted data back to Slack
    await sendSlackMessage(channelId, formattedData);
  } catch (error) {
    console.error(`Error fetching ${dataType} from Bubble:`, error);
    await sendSlackMessage(channelId, `Error fetching ${dataType}. Please try again later.`);
  }
}

// Handle commands that perform actions in Bubble
async function handleActionCommand(command, channelId) {
  // Parse the action to perform
  const action = command.replace('do', '').trim();
  
  try {
    // Call Bubble.io API to perform the action
    const response = await axios.post(`${BUBBLE_API_URL}/action/${action}`, {
      // Include any parameters needed for the action
    }, {
      headers: {
        'Authorization': 'Bearer YOUR_BUBBLE_API_TOKEN'
      }
    });
    
    // Send confirmation to Slack
    await sendSlackMessage(channelId, `Action "${action}" has been performed successfully!`);
  } catch (error) {
    console.error(`Error performing action ${action} in Bubble:`, error);
    await sendSlackMessage(channelId, `Error performing "${action}". Please try again later.`);
  }
}

// Helper function to send messages to Slack
async function sendSlackMessage(channelId, text) {
  try {
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channelId,
      text: text
    }, {
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
  } catch (error) {
    console.error('Error sending message to Slack:', error);
  }
}

// Helper function to format Bubble data for Slack
function formatBubbleData(data, dataType) {
  // Format the data based on the data type
  // This is where you'll create nice-looking Slack messages
  
  if (!data || data.length === 0) {
    return `No ${dataType} found.`;
  }
  
  // Example formatting for a list of items
  if (Array.isArray(data)) {
    return `*${dataType.toUpperCase()}*:\n${data.map((item, index) => 
      `${index + 1}. ${item.name || item.title || JSON.stringify(item)}`
    ).join('\n')}`;
  }
  
  // Default formatting for other data types
  return `*${dataType.toUpperCase()}*:\n${JSON.stringify(data, null, 2)}`;
}

// Function to send a DM to a user
async function sendDirectMessage(userId, text) {
  try {
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
  } catch (error) {
    console.error('Error sending DM:', error);
  }
}

// Endpoint for Bubble.io to trigger notifications to users
app.post('/bubble/notify', async (req, res) => {
  const { slackUserId, message } = req.body;
  
  if (!slackUserId || !message) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }
  
  try {
    await sendDirectMessage(slackUserId, message);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});