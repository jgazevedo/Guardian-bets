const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { getUserData, updateUserPoints, canClaimDaily, claimDaily, addExperience } = require('../database/userService');
const { pool } = require('../database/database');
const { formatNumber, formatDate, createEmbed, createErrorEmbed, createSuccessEmbed } = require('../utils/helpers');
const { isAdmin } = require('../utils/permissions');

async function handleInteraction(interaction, client) {
  if (!interaction.isChatInputCommand() && !interaction.isStringSelectMenu() && !interaction.isUserSelectMenu()) return;

  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction, client);
    } else if (interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
      await handleSelectMenu(interaction, client);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    const errorEmbed = createErrorEmbed('An error occurred while processing your request!');
    
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ embeds: [errorEmbed], ephemeral: true });
    } else {
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
    }
  }
}

async function handleSlashCommand(interaction, client) {
  const { commandName, user } = interaction;

  switch (commandName) {
    case 'enterbetting':
      await handleEnterBetting(interaction);
      break;
    case 'createpool':
      await handleCreatePool(interaction);
      break;
    case 'resolvepool':
      await handleResolvePool(interaction);
      break;
    case 'betlog':
      await handleBetLog(interaction, client);
      break;
    case 'viewpools':
      await handleViewPools(interaction);
      break;
    case 'bet':
      await handleBet(interaction);
      break;
    case 'lend':
      await handleLend(interaction);
      break;
    case 'pay':
      await handlePay(interaction);
      break;
    case 'extendloan':
      await handleExtendLoan(interaction);
      break;
    case 'viewloans':
      await handleViewLoans(interaction, client);
      break;
    case 'bounty':
      await handleBounty(interaction, client);
      break;
    case 'cashin':
      await handleCashIn(interaction, client);
      break;
    case 'points':
      await handlePoints(interaction, client);
      break;
    case 'leaderboard':
      await handleLeaderboard(interaction, client);
      break;
    case 'admin':
      await handleAdmin(interaction, client);
      break;
    case 'help':
      await handleHelp(interaction);
      break;
    default:
      const errorEmbed = createErrorEmbed('Unknown command!');
      await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

// Betting System Handlers
async function handleEnterBetting(interaction) {
  const userData = await getUserData(interaction.user.id);
  
  const embed = createSuccessEmbed(
    '🎲 Welcome to the Betting System!',
    `You're now registered for betting with **${formatNumber(userData.points)}** points!\n\n` +
    '**Available Commands:**\n' +
    '• `/viewpools` - View active betting pools\n' +
    '• `/bet` - Place a bet on a pool\n' +
    '• `/betlog` - View your betting history\n' +
    '• `/createpool` - Create your own betting pool\n\n' +
    '**How it works:**\n' +
    '1. View active pools with `/viewpools`\n' +
    '2. Place bets using `/bet` command\n' +
    '3. Wait for pool resolution\n' +
    '4. Collect winnings automatically!'
  );
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleCreatePool(interaction) {
  const title = interaction.options.getString('title');
  const description = interaction.options.getString('description') || 'No description provided';
  const duration = interaction.options.getInteger('duration') || 24;
  
  const options = [];
  for (let i = 1; i <= 5; i++) {
    const option = interaction.options.getString(`option${i}`);
    if (option) options.push(option);
  }
  
  if (options.length < 2) {
    const errorEmbed = createErrorEmbed('You must provide at least 2 betting options!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  try {
    const endDate = new Date();
    endDate.setHours(endDate.getHours() + duration);
    
    const result = await pool.query(`
      INSERT INTO betting_pools (title, description, creator_id, end_date) 
      VALUES ($1, $2, $3, $4) 
      RETURNING id
    `, [title, description, interaction.user.id, endDate]);
    
    const poolId = result.rows[0].id;
    
    // Store betting options
    for (const option of options) {
      await pool.query(`
        INSERT INTO betting_options (pool_id, option_name) 
        VALUES ($1, $2)
      `, [poolId, option]);
    }
    
    const embed = createSuccessEmbed(
      '🎯 Betting Pool Created!',
      `**Pool #${poolId}**: ${title}\n` +
      `📝 **Description:** ${description}\n` +
      `⏰ **Duration:** ${duration} hours\n` +
      `📅 **Ends:** ${formatDate(endDate)}\n\n` +
      `**Betting Options:**\n${options.map((opt, i) => `${i + 1}. ${opt}`).join('\n')}\n\n` +
      `Use \`/bet\` to place bets on this pool!`
    );
    
    await interaction.reply({ embeds: [embed] });
  } catch (error) {
    console.error('Create pool error:', error);
    const errorEmbed = createErrorEmbed('Failed to create betting pool!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

async function handleResolvePool(interaction) {
  if (!isAdmin(interaction.user.id)) {
    const errorEmbed = createErrorEmbed('Only admins can resolve betting pools!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  try {
    const result = await pool.query(`
      SELECT bp.*, array_agg(bo.option_name) as options
      FROM betting_pools bp
      LEFT JOIN betting_options bo ON bp.id = bo.pool_id
      WHERE bp.status = 'active'
      GROUP BY bp.id
      ORDER BY bp.created_at DESC
      LIMIT 10
    `);
    
    if (result.rows.length === 0) {
      const embed = createEmbed('📊 No Active Pools', 'There are no active betting pools to resolve.', 0x3498db);
      return await interaction.reply({ embeds: [embed], ephemeral: true });
    }
    
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('resolve_pool_select')
      .setPlaceholder('Select a pool to resolve')
      .addOptions(
        result.rows.map(poolData => ({
          label: `Pool #${poolData.id}: ${poolData.title}`,
          description: `Created ${formatDate(poolData.created_at)}`,
          value: poolData.id.toString()
        }))
      );
    
    const row = new ActionRowBuilder().addComponents(selectMenu);
    
    const embed = createEmbed(
      '🎯 Resolve Betting Pool',
      'Select a betting pool to resolve from the dropdown below.',
      0x3498db
    );
    
    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  } catch (error) {
    console.error('Resolve pool error:', error);
    const errorEmbed = createErrorEmbed('Failed to load betting pools!');
    await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
}

// Points System Handlers
async function handlePoints(interaction, client) {
  const subcommand = interaction.options.getSubcommand();
  
  switch (subcommand) {
    case 'view':
      await handlePointsView(interaction, client);
      break;
    case 'give':
      await handlePointsGive(interaction);
      break;
    case 'daily':
      await handlePointsDaily(interaction);
      break;
    case 'interest':
      await handlePointsInterest(interaction);
      break;
  }
}

async function handlePointsView(interaction, client) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const userData = await getUserData(targetUser.id);
  
  if (!userData) {
    const errorEmbed = createErrorEmbed('User data not found!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  // Get user's rank
  const rankResult = await pool.query(`
    SELECT COUNT(*) + 1 as rank 
    FROM user_points 
    WHERE points > $1
  `, [userData.points]);
  
  const rank = rankResult.rows[0].rank;
  
  // Calculate next level progress
  const currentLevelExp = (userData.level - 1) * 100;
  const nextLevelExp = userData.level * 100;
  const progress = ((userData.experience - currentLevelExp) / 100) * 100;
  
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`💰 ${targetUser.username}'s Profile`)
    .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
    .addFields(
      { name: '💎 Current Points', value: formatNumber(userData.points), inline: true },
      { name: '📊 Rank', value: `#${rank}`, inline: true },
      { name: '⭐ Level', value: `${userData.level}`, inline: true },
      { name: '🎯 Experience', value: `${userData.experience} XP`, inline: true },
      { name: '📈 Progress to Next Level', value: `${progress.toFixed(1)}%`, inline: true },
      { name: '💰 Total Earned', value: formatNumber(userData.total_earned), inline: true },
      { name: '💸 Total Spent', value: formatNumber(userData.total_spent), inline: true },
      { name: '📅 Last Daily Claim', value: userData.daily_claimed_at ? formatDate(userData.daily_claimed_at) : 'Never', inline: true },
      { name: '🕐 Account Created', value: formatDate(userData.created_at), inline: true }
    )
    .setFooter({ text: 'Use /points daily to claim your daily bonus!' })
    .setTimestamp();
  
  await interaction.reply({ embeds: [embed], ephemeral: targetUser.id !== interaction.user.id });
}

async function handlePointsDaily(interaction) {
  const canClaim = await canClaimDaily(interaction.user.id);
  
  if (!canClaim) {
    const userData = await getUserData(interaction.user.id);
    const lastClaim = new Date(userData.daily_claimed_at);
    const nextClaim = new Date(lastClaim.getTime() + 24 * 60 * 60 * 1000);
    
    const embed = createErrorEmbed(
      'Daily Bonus Already Claimed!',
      `You can claim your next daily bonus ${formatDate(nextClaim)}`
    );
    return await interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  const result = await claimDaily(interaction.user.id);
  
  if (!result) {
    const errorEmbed = createErrorEmbed('Failed to claim daily bonus!');
    return await interaction.reply({ embeds: [errorEmbed], ephemeral: true });
  }
  
  // Add experience for daily claim
  const expResult = await addExperience(interaction.user.id, 10);
  
  const embed = createSuccessEmbed(
    '🎁 Daily Bonus Claimed!',
    `You received **${formatNumber(result.bonus)}** points!\n` +
    `💰 **New Balance:** ${formatNumber(result.newPoints)} points\n` +
    `🎯 **Experience Gained:** +10 XP` +
    (expResult?.levelUp ? `\n🎉 **Level Up!** You're now level ${expResult.newLevel}!` : '')
  );
  
  await interaction.reply({ embeds: [embed], ephemeral: true });
}

// Helper function to handle select menus
async function handleSelectMenu(interaction, client) {
  if (interaction.customId === 'resolve_pool_select') {
    await handlePoolResolution(interaction, client);
  } else if (interaction.customId === 'lend_user_select') {
    await handleLendUserSelect(interaction);
  } else if (interaction.customId === 'bet_pool_select') {
    await handleBetPoolSelect(interaction);
  }
}

module.exports = { handleInteraction };