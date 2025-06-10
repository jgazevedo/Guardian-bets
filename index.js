const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, MessageFlags } = require('discord.js');
const { Pool } = require('pg');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query('DROP TABLE IF EXISTS user_points CASCADE');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        user_id VARCHAR(20) PRIMARY KEY,
        points INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS betting_pools (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        creator_id VARCHAR(20),
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        message_id VARCHAR(20),
        channel_id VARCHAR(20)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_options (
        id SERIAL PRIMARY KEY,
        pool_id INTEGER REFERENCES betting_pools(id),
        option_text VARCHAR(255),
        emoji VARCHAR(10),
        is_correct BOOLEAN DEFAULT FALSE
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id),
        option_id INTEGER REFERENCES pool_options(id),
        amount INTEGER,
        locked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// Database helper functions
async function getUserPoints(userId) {
  try {
    const result = await pool.query('SELECT points FROM user_points WHERE user_id = $1', [userId]);
    if (result.rows.length === 0) return null;
    return result.rows[0].points;
  } catch (error) {
    console.error('Error getting user points:', error);
    return null;
  }
}

async function registerUser(userId) {
  try {
    const result = await pool.query(`
      INSERT INTO user_points (user_id, points) VALUES ($1, 1000) 
      ON CONFLICT (user_id) DO NOTHING RETURNING points
    `, [userId]);
    return result.rows.length > 0;
  } catch (error) {
    console.error('Error registering user:', error);
    return false;
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(`
      INSERT INTO user_points (user_id, points) VALUES ($1, $2) 
      ON CONFLICT (user_id) DO UPDATE SET points = $2
    `, [userId, points]);
    return true;
  } catch (error) {
    console.error('Error updating user points:', error);
    return false;
  }
}

async function createPool(creatorId, title, description, options) {
  try {
    const result = await pool.query(
      'INSERT INTO betting_pools (creator_id, title, description) VALUES ($1, $2, $3) RETURNING id',
      [creatorId, title, description]
    );
    const poolId = result.rows[0].id;
    for (const { text, emoji } of options) {
      await pool.query(
        'INSERT INTO pool_options (pool_id, option_text, emoji) VALUES ($1, $2, $3)',
        [poolId, text, emoji]
      );
    }
    return poolId;
  } catch (error) {
    console.error('Error creating pool:', error);
    return null;
  }
}

async function getOpenPools(creatorId) {
  try {
    return await pool.query(
      'SELECT id, title, description FROM betting_pools WHERE status = $1 AND (creator_id = $2 OR EXISTS (SELECT 1 FROM user_points WHERE user_id = $2 AND points > 0))',
      ['active', creatorId]
    );
  } catch (error) {
    console.error('Error getting open pools:', error);
    return [];
  }
}

async function getPoolOptions(poolId) {
  try {
    return await pool.query('SELECT id, option_text, emoji FROM pool_options WHERE pool_id = $1', [poolId]);
  } catch (error) {
    console.error('Error getting pool options:', error);
    return [];
  }
}

async function recordBet(userId, poolId, optionId, amount) {
  try {
    await pool.query(
      'INSERT INTO user_bets (user_id, pool_id, option_id, amount, locked_at) VALUES ($1, $2, $3, $4, NULL)',
      [userId, poolId, optionId, amount]
    );
    const currentPoints = await getUserPoints(userId);
    await updateUserPoints(userId, currentPoints - amount);
    return true;
  } catch (error) {
    console.error('Error recording bet:', error);
    return false;
  }
}

async function lockBet(userId, poolId) {
  try {
    await pool.query(
      'UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL',
      [userId, poolId]
    );
    return true;
  } catch (error) {
    console.error('Error locking bet:', error);
    return false;
  }
}

async function closePool(poolId, correctOptionId) {
  try {
    await pool.query('UPDATE betting_pools SET status = $1 WHERE id = $2', ['closed', poolId]);
    await pool.query('UPDATE pool_options SET is_correct = TRUE WHERE id = $1', [correctOptionId]);
    const bets = await pool.query(
      'SELECT user_id, amount FROM user_bets WHERE pool_id = $1 AND option_id = $2 AND locked_at IS NOT NULL',
      [poolId, correctOptionId]
    );
    const totalStaked = bets.rows.reduce((sum, bet) => sum + bet.amount, 0);
    for (const bet of bets.rows) {
      const reward = (bet.amount / totalStaked) * totalStaked * 0.9; // 90% payout, 10% house cut
      const currentPoints = await getUserPoints(bet.user_id) || 0;
      await updateUserPoints(bet.user_id, currentPoints + reward);
    }
    return true;
  } catch (error) {
    console.error('Error closing pool:', error);
    return false;
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Admin user IDs
const adminUserIds = ['121564489043804161'];

// Check if user is an admin
function isAdmin(userId, member) {
  const hasAdminPermission = member.permissions.has(PermissionFlagsBits.Administrator);
  const isHardcodedAdmin = adminUserIds.includes(userId);
  console.log(`Admin check for user ${userId}: Administrator permission: ${hasAdminPermission}, Hardcoded admin: ${isHardcodedAdmin}, Result: ${hasAdminPermission || isHardcodedAdmin}`);
  return hasAdminPermission || isHardcodedAdmin;
}

// Pool state management
const activePools = new Map();
const betTimeouts = new Map();

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily points bonus'),
  new SlashCommandBuilder()
    .setName('participate')
    .setDescription('Join the bot and receive 1000 starting points'),
  new SlashCommandBuilder()
    .setName('wallet')
    .setDescription('Check your current points balance'),
  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add points to a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove points from a user (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new betting pool'),
  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close a betting pool and select the correct answer (Admin or creator only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    console.log('🔄 Started refreshing application (/) commands.');
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] });
    console.log('✅ Cleared global commands.');
    await rest.put(
      Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, '979180991836995674'),
      { body: commands }
    );
    console.log('✅ Successfully reloaded guild-specific commands (instant update).');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

// Bot event handlers
client.once('ready', async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`);
  await initDatabase();
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (interaction.isChatInputCommand()) {
    const { commandName, user, member } = interaction;
    try {
      console.log(`Command: ${commandName}, User: ${user.id}, Member: ${JSON.stringify(member)}`);
      switch (commandName) {
        case 'daily': {
          const currentPoints = await getUserPoints(user.id);
          if (currentPoints === null) {
            await interaction.reply({ content: '❌ You must use `/participate` first to join the bot!', flags: MessageFlags.Ephemeral });
            break;
          }
          const dailyBonus = 100;
          const newPoints = currentPoints + dailyBonus;
          await updateUserPoints(user.id, newPoints);
          await interaction.reply({ content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'participate': {
          const isNewUser = await registerUser(user.id);
          if (isNewUser) {
            await interaction.reply({ content: `✅ **Welcome!** You've joined the bot and received **1000** starting points!`, flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: `❌ You've already joined the bot! Use /wallet to check your balance.`, flags: MessageFlags.Ephemeral });
          }
          break;
        }
        case 'wallet': {
          const points = await getUserPoints(user.id);
          if (points === null) {
            await interaction.reply({ content: `❌ You haven't joined yet! Use /participate to start with 1000 points.`, flags: MessageFlags.Ephemeral });
            break;
          }
          await interaction.reply({ content: `💰 **${user.username}**, your current balance is **${formatNumber(points)}** points!`, flags: MessageFlags.Ephemeral });
          break;
        }
        case 'add': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or have specific admin clearance to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          const modal = new ModalBuilder()
            .setCustomId('add_credits_modal')
            .setTitle('Add Credits');
          const userSelect = new UserSelectMenuBuilder()
            .setCustomId('user_select')
            .setPlaceholder('Select a user')
            .setMinValues(1)
            .setMaxValues(1);
          const creditsInput = new TextInputBuilder()
            .setCustomId('credits')
            .setLabel('Credits')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter number of points to add (1-999999)')
            .setRequired(true);
          const balanceInfo = new TextInputBuilder()
            .setCustomId('user_balance_info')
            .setLabel('User balance')
            .setStyle(TextInputStyle.Short)
            .setValue('Select a user to view their balance')
            .setRequired(false)
            .setDisabled(true);
          modal.addComponents(
            new ActionRowBuilder().addComponents(userSelect),
            new ActionRowBuilder().addComponents(creditsInput),
            new ActionRowBuilder().addComponents(balanceInfo)
          );
          console.log('Showing modal for /add:', modal);
          await interaction.showModal(modal);
          break;
        }
        case 'remove': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or have specific admin clearance to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          const modal = new ModalBuilder()
            .setCustomId('remove_credits_modal')
            .setTitle('Remove Credits');
          const userSelect = new UserSelectMenuBuilder()
            .setCustomId('user_select')
            .setPlaceholder('Select a user')
            .setMinValues(1)
            .setMaxValues(1);
          const creditsInput = new TextInputBuilder()
            .setCustomId('credits')
            .setLabel('Credits')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter number of points to remove (1-999999)')
            .setRequired(true);
          const balanceInfo = new TextInputBuilder()
            .setCustomId('user_balance_info')
            .setLabel('User balance')
            .setStyle(TextInputStyle.Short)
            .setValue('Select a user to view their balance')
            .setRequired(false)
            .setDisabled(true);
          modal.addComponents(
            new ActionRowBuilder().addComponents(userSelect),
            new ActionRowBuilder().addComponents(creditsInput),
            new ActionRowBuilder().addComponents(balanceInfo)
          );
          console.log('Showing modal for /remove:', modal);
          await interaction.showModal(modal);
          break;
        }
        case 'create': {
          const modal = new ModalBuilder()
            .setCustomId('create_pool_modal')
            .setTitle('Create Betting Pool');
          const descriptionInput = new TextInputBuilder()
            .setCustomId('pool_description')
            .setLabel('Description')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);
          const optionInputs = [];
          for (let i = 1; i <= 3; i++) {
            optionInputs.push(
              new TextInputBuilder()
                .setCustomId(`option_${i}`)
                .setLabel(`Option ${i} (text + emoji)`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('e.g., Yes 👍')
                .setRequired(true)
            );
          }
          modal.addComponents(
            new ActionRowBuilder().addComponents(descriptionInput),
            ...optionInputs.map(input => new ActionRowBuilder().addComponents(input))
          );
          console.log('Showing modal for /create:', modal);
          await interaction.showModal(modal);
          break;
        }
        case 'close': {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({ content: '❌ You must be a server administrator or the pool creator to use this command!', flags: MessageFlags.Ephemeral });
            break;
          }
          const pools = await getOpenPools(user.id);
          if (pools.rows.length === 0) {
            await interaction.reply({ content: '❌ No open pools available to close.', flags: MessageFlags.Ephemeral });
            break;
          }
          const poolSelect = new UserSelectMenuBuilder()
            .setCustomId('pool_select')
            .setPlaceholder('Select a pool to close')
            .setMinValues(1)
            .setMaxValues(1);
          poolSelect.addOptions(pools.rows.map(pool => ({
            label: pool.title,
            value: pool.id.toString(),
            description: pool.description.substring(0, 50)
          })));
          const row = new ActionRowBuilder().addComponents(poolSelect);
          console.log('Showing pool select for /close:', row);
          await interaction.reply({ content: 'Select a pool to close:', components: [row], flags: MessageFlags.Ephemeral });
          break;
        }
        default:
          await interaction.reply({ content: '❌ Unknown command!', flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('Command error:', error.stack);
      await interaction.reply({ content: '❌ An error occurred while processing your command! Check logs for details.', flags: MessageFlags.Ephemeral });
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const { customId, fields, components } = interaction;
      console.log(`Modal submit: ${customId}, Fields: ${JSON.stringify(fields.fields)}, Components: ${JSON.stringify(components)}`);
      if (customId === 'add_credits_modal' || customId === 'remove_credits_modal') {
        const userSelect = components[0]?.components[0];
        const selectedUserId = userSelect?.data?.values ? userSelect.data.values[0] : null;
        if (!selectedUserId) {
          console.log('No user selected in modal, Components:', JSON.stringify(components));
          await interaction.reply({ content: '❌ No user selected!', flags: MessageFlags.Ephemeral });
          return;
        }
        console.log(`Selected user ID: ${selectedUserId}`);
        const credits = parseInt(fields.getTextInputValue('credits'));
        if (isNaN(credits) || credits < 1 || credits > 999999) {
          console.log(`Invalid credits: ${fields.getTextInputValue('credits')}`);
          await interaction.reply({ content: '❌ Invalid credits amount! Must be a number between 1 and 999999.', flags: MessageFlags.Ephemeral });
          return;
        }
        const currentPoints = await getUserPoints(selectedUserId);
        if (currentPoints === null) {
          console.log(`User ${selectedUserId} not registered`);
          await interaction.reply({ content: `❌ User <@${selectedUserId}> has not joined yet! They must use /participate first.`, flags: MessageFlags.Ephemeral });
          return;
        }
        let newPoints;
        if (customId === 'add_credits_modal') {
          newPoints = currentPoints + credits;
          await updateUserPoints(selectedUserId, newPoints);
          console.log(`Added ${credits} points to ${selectedUserId}, new balance: ${newPoints}`);
          await interaction.reply({ content: `✅ Added **${formatNumber(credits)}** points to <@${selectedUserId}>!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
        } else if (customId === 'remove_credits_modal') {
          if (currentPoints < credits) {
            console.log(`Insufficient points for ${selectedUserId}: ${currentPoints} < ${credits}`);
            await interaction.reply({ content: `❌ User <@${selectedUserId}> only has **${formatNumber(currentPoints)}** points! Cannot remove **${formatNumber(credits)}** points.`, flags: MessageFlags.Ephemeral });
            return;
          }
          newPoints = currentPoints - credits;
          await updateUserPoints(selectedUserId, newPoints);
          console.log(`Removed ${credits} points from ${selectedUserId}, new balance: ${newPoints}`);
          await interaction.reply({ content: `✅ Removed **${formatNumber(credits)}** points from <@${selectedUserId}>!\n💰 New balance: **${formatNumber(newPoints)}** points`, flags: MessageFlags.Ephemeral });
        }
      } else if (customId === 'create_pool_modal') {
        const description = fields.getTextInputValue('pool_description');
        const options = [];
        for (let i = 1; i <= 3; i++) {
          const optionText = fields.getTextInputValue(`option_${i}`);
          if (optionText) {
            const emojiMatch = optionText.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/);
            options.push({ text: optionText.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/, '').trim(), emoji: emojiMatch ? emojiMatch[0] : '' });
          }
        }
        if (options.length < 3 || !description) {
          await interaction.reply({ content: '❌ Please fill all fields with at least 3 options and a description.', flags: MessageFlags.Ephemeral });
          return;
        }
        const poolId = await createPool(interaction.user.id, `Pool by ${interaction.user.username}`, description, options);
        if (!poolId) {
          await interaction.reply({ content: '❌ Failed to create pool.', flags: MessageFlags.Ephemeral });
          return;
        }
        const channel = interaction.channel;
        const poolMessage = await channel.send({
          content: `**New Pool: ${description}**\n(Created by <@${interaction.user.id}>, closes in 3 minutes)`,
          components: [new ActionRowBuilder().addComponents(options.map((opt, i) => new ButtonBuilder()
            .setCustomId(`bet_${poolId}_${i}`)
            .setLabel(opt.text || `Option ${i + 1}`)
            .setStyle(ButtonStyle.Primary)
            .setEmoji(opt.emoji)
          ))]
        });
        await pool.query('UPDATE betting_pools SET message_id = $1, channel_id = $2 WHERE id = $3', [poolMessage.id, channel.id, poolId]);
        activePools.set(poolId, { messageId: poolMessage.id, channelId: channel.id });
        setTimeout(async () => {
          await pool.query('UPDATE betting_pools SET status = $1 WHERE id = $2', ['closed', poolId]);
          const message = await channel.messages.fetch(poolMessage.id);
          await message.edit({ components: [] });
          activePools.delete(poolId);
        }, 3 * 60 * 1000);
        await interaction.reply({ content: `✅ Pool created! It will close in 3 minutes.`, flags: MessageFlags.Ephemeral });
      } else if (customId.startsWith('bet_confirm_')) {
        const [action, poolId, optionIndex] = customId.split('_');
        const stake = parseInt(fields.getTextInputValue('stake'));
        const userId = interaction.user.id;
        const currentPoints = await getUserPoints(userId);
        if (isNaN(stake) || stake < 1 || stake > 999999 || (currentPoints !== null && currentPoints < stake)) {
          await interaction.reply({ content: '❌ Invalid stake amount or insufficient points!', flags: MessageFlags.Ephemeral });
          return;
        }
        const options = await getPoolOptions(poolId);
        const optionId = options.rows[optionIndex].id;
        await recordBet(userId, poolId, optionId, stake);
        betTimeouts.set(`${userId}_${poolId}`, setTimeout(() => lockBet(userId, poolId), 30 * 1000));
        await interaction.reply({ content: `✅ Bet of ${formatNumber(stake)} points placed! You have 30 seconds to change it.`, flags: MessageFlags.Ephemeral });
      }
    } catch (error) {
      console.error('Modal submission error:', error.stack);
      await interaction.reply({ content: '❌ An error occurred while processing your request! Check logs for details.', flags: MessageFlags.Ephemeral });
    }
  } else if (interaction.isButton()) {
    try {
      const [action, poolId, optionIndex] = interaction.customId.split('_');
      if (action === 'bet') {
        const pool = await pool.query('SELECT * FROM betting_pools WHERE id = $1 AND status = $2', [poolId, 'active']);
        if (!pool.rows.length) {
          await interaction.reply({ content: '❌ This pool is closed or does not exist.', flags: MessageFlags.Ephemeral });
          return;
        }
        const modal = new ModalBuilder()
          .setCustomId(`bet_confirm_${poolId}_${optionIndex}`)
          .setTitle('Place Your Bet');
        const stakeInput = new TextInputBuilder()
          .setCustomId('stake')
          .setLabel('Stake Amount')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Enter points to stake (1-999999)')
          .setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(stakeInput));
        console.log('Showing bet modal:', modal);
        await interaction.showModal(modal);
      }
    } catch (error) {
      console.error('Button interaction error:', error.stack);
      await interaction.reply({ content: '❌ An error occurred while processing your bet!', flags: MessageFlags.Ephemeral });
    }
  } else if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === 'pool_select') {
        const poolId = interaction.values[0];
        const modal = new ModalBuilder()
          .setCustomId(`close_confirm_${poolId}`)
          .setTitle('Select Correct Answer');
        const optionSelect = new UserSelectMenuBuilder()
          .setCustomId('option_select')
          .setPlaceholder('Select the correct option')
          .setMinValues(1)
          .setMaxValues(1);
        const options = (await getPoolOptions(poolId)).rows;
        optionSelect.addOptions(options.map((opt, i) => ({
          label: opt.option_text,
          value: opt.id.toString(),
          description: `Option ${i + 1}`
        })));
        const row = new ActionRowBuilder().addComponents(optionSelect);
        console.log('Showing option select for /close:', row);
        await interaction.update({ content: 'Select the correct answer:', components: [row], flags: MessageFlags.Ephemeral });
      } else if (interaction.customId.startsWith('close_confirm_')) {
        const poolId = interaction.customId.split('_')[2];
        const correctOptionId = interaction.values[0];
        if (await closePool(poolId, correctOptionId)) {
          await interaction.update({ content: `✅ Pool ${poolId} closed. Points distributed!`, components: [], flags: MessageFlags.Ephemeral });
        } else {
          await interaction.update({ content: '❌ Failed to close pool.', components: [], flags: MessageFlags.Ephemeral });
        }
      }
    } catch (error) {
      console.error('Select menu error:', error.stack);
      await interaction.reply({ content: '❌ An error occurred while processing your selection!', flags: MessageFlags.Ephemeral });
    }
  }
});

console.log('Token length:', process.env.DISCORD_BOT_TOKEN?.length);
console.log('Token starts with:', process.env.DISCORD_BOT_TOKEN?.substring(0, 10));
console.log('Token ends with:', process.env.DISCORD_BOT_TOKEN?.substring(-10));

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down...');
  await pool.end();
  client.destroy();
  process.exit(0);
});
