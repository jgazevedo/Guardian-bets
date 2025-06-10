const { Client, GatewayIntentBits } = require('discord.js');
const { initDatabase } = require('./database/database');
const { registerCommands } = require('./handlers/commandHandler');
const { handleInteraction } = require('./handlers/interactionHandler');
const { startCronJobs } = require('./utils/cronJobs');
require('dotenv').config();

// Create Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Bot ready event
client.once('ready', async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  console.log(`🔗 Serving ${client.guilds.cache.size} guilds`);
  
  // Initialize database
  await initDatabase();
  
  // Register slash commands
  await registerCommands();
  
  // Start cron jobs for daily bonuses, loan reminders, etc.
  startCronJobs(client);
  
  // Set bot status
  client.user.setActivity('💰 Economy System | /help', { type: 'WATCHING' });
});

// Handle interactions
client.on('interactionCreate', async (interaction) => {
  await handleInteraction(interaction, client);
});

// Error handling
client.on('error', console.error);
client.on('warn', console.warn);

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down gracefully...');
  client.destroy();
  process.exit(0);
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);