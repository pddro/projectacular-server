// server.js - Slack Bot for Bubble.io Integration
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const app = express();
const PORT = process.env.PORT || 3000;

// Your configuration - using environment variables
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const BUBBLE_API_URL = process.env.BUBBLE_API_URL || 'https://projectacular.bubbleapps.io/version-test/api/1.1/wf';
const BUBBLE_API_KEY = process.env.BUBBLE_API_KEY || '5f295f248f6872648f79cf0ff089cac0';

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Verify Slack requests 
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
  // Extract the text after the bot mention
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  
  // Parse the command from the message (remove the bot mention part)
  const botMentionMatch = event.text.match(/<@([A-Z0-9]+)>/);
  if (!botMentionMatch) {
    console.log("Could not extract bot user ID from mention");
    return;
  }
  
  const botUserId = botMentionMatch[1];
  const command = text.replace(`<@${botUserId}>`, '').trim();
  
  console.log(`Received mention command: "${command}" from user ${userId} in channel ${channelId}`);
  
  // Process the command
  await processCommand(command, channelId, userId);
}

// Function to handle direct messages to the bot
async function handleDirectMessage(event) {
  const text = event.text;
  const channelId = event.channel;
  const userId = event.user;
  
  console.log(`Received DM: "${text}" from user ${userId} in channel ${channelId}`);
  
  // For DMs, we use the entire message as the command
  await processCommand(text, channelId, userId);
}

// Process commands from both mentions and DMs
async function processCommand(text, channelId, userId) {
  if (text.startsWith('fetch')) {
    // Handle data fetching commands
    await handleFetchCommand(text, channelId);
  } else if (text.toLowerCase().startsWith('create task')) {
    // Handle create task command
    await handleCreateTaskCommand(text, channelId, userId);
  } else if (text.startsWith('do')) {
    // Handle action commands
    await handleActionCommand(text, channelId);
  } else if (text.toLowerCase() === 'help') {
    // Provide help information
    await sendSlackMessage(channelId, 
      "Here's how you can use me:\n\n" +
      "• `fetch [data]` - Get data from Projectacular\n" +
      "• `create task \"Task name\" [description]` - Create a new task\n" +
      "• `do [action]` - Perform an action in Projectacular\n\n" +
      "For example:\n" +
      "• `fetch tasks` - Get a list of tasks\n" +
      "• `fetch projects` - Get a list of projects\n" +
      "• `create task \"New homepage design\" priority:high assignee:@john` - Create a new task"
    );
  } else {
    // Unknown command
    await sendSlackMessage(channelId, 
      "Sorry, I didn't understand that command. Try `fetch [data]`, `create task [name]`, or type `help` for more information.");
  }
}

// Handle create task commands
async function handleCreateTaskCommand(command, channelId, userId) {
  try {
    console.log(`Processing create task command: ${command}`);
    
    // Extract task name using regex to handle quoted task names
    // This regex looks for text between quotes after "create task"
    const taskNameMatch = command.match(/create task\s+"([^"]+)"/i);
    let taskName, taskDescription;
    
    if (taskNameMatch && taskNameMatch[1]) {
      taskName = taskNameMatch[1].trim();
      
      // Anything after the quoted task name can be considered description or metadata
      const afterTaskName = command.substring(command.indexOf(taskNameMatch[0]) + taskNameMatch[0].length).trim();
      if (afterTaskName) {
        taskDescription = afterTaskName;
      }
    } else {
      // If no quoted task name, just take everything after "create task" as the name
      taskName = command.replace(/create task/i, '').trim();
      taskDescription = '';
    }
    
    if (!taskName) {
      await sendSlackMessage(channelId, "Please provide a task name. Example: `create task \"Design homepage\"`");
      return;
    }
    
    console.log(`Creating task "${taskName}" with description "${taskDescription || 'None'}"`);
    
    // Get user information to include in the task
    const userInfo = await getSlackUserInfo(userId);
    
    // Prepare task data
    const taskData = {
      name: taskName,
      description: taskDescription || '',
      created_by: userId,
      creator_name: userInfo ? userInfo.real_name || userInfo.name : userId,
      created_from: 'slack',
      channel_id: channelId
    };
    
    // Send to Bubble API
    const response = await axios.post(`${BUBBLE_API_URL}/create_task`, taskData, {
      headers: {
        'Authorization': `Bearer ${BUBBLE_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log('Task creation response:', response.data);
    
    if (response.data && response.data.success) {
      await sendSlackMessage(channelId, `✅ Task "${taskName}" created successfully! Task ID: ${response.data.task_id || 'N/A'}`);
    } else {
      throw new Error('Bubble API did not return success');
    }
  } catch (error) {
    console.error('Error creating task:', error.message);
    await sendSlackMessage(channelId, `⚠️ Error creating task: ${error.message}. Please try again later.`);
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

// Handle commands that fetch data from Bubble
async function handleFetchCommand(command, channelId) {
  // Parse what data to fetch (e.g., "fetch users", "fetch tasks", etc.)
  const dataType = command.replace('fetch', '').trim();
  
  try {
    console.log(`Attempting to fetch ${dataType} from Bubble`);
    
    // Call Bubble.io API to get the requested data
    const response = await axios.get(`${BUBBLE_API_URL}/data/${dataType}`, {
      headers: {
        'Authorization': `Bearer ${BUBBLE_API_KEY}`
      }
    });
    
    console.log(`Successfully fetched ${dataType} from Bubble`);
    
    // Format the response data for Slack
    const formattedData = formatBubbleData(response.data, dataType);
    
    // Send the formatted data back to Slack
    await sendSlackMessage(channelId, formattedData);
  } catch (error) {
    console.error(`Error fetching ${dataType} from Bubble:`, error.message);
    await sendSlackMessage(channelId, `Error fetching ${dataType}. Please try again later.`);
  }
}

// Handle commands that perform actions in Bubble
async function handleActionCommand(command, channelId) {
  // Parse the action to perform
  const action = command.replace('do', '').trim();
  
  try {
    console.log(`Attempting to perform action ${action} in Bubble`);
    
    // Call Bubble.io API to perform the action
    const response = await axios.post(`${BUBBLE_API_URL}/action/${action}`, {
      // Include any parameters needed for the action
    }, {
      headers: {
        'Authorization': `Bearer ${BUBBLE_API_KEY}`
      }
    });
    
    console.log(`Action ${action} performed successfully`);
    
    // Send confirmation to Slack
    await sendSlackMessage(channelId, `Action "${action}" has been performed successfully!`);
  } catch (error) {
    console.error(`Error performing action ${action} in Bubble:`, error.message);
    await sendSlackMessage(channelId, `Error performing "${action}". Please try again later.`);
  }
}

// Helper function to send messages to Slack
async function sendSlackMessage(channelId, text) {
  try {
    console.log(`Sending message to channel ${channelId}`);
    
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel: channelId,
      text: text
    }, {
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
