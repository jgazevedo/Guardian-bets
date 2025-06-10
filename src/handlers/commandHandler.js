const { SlashCommandBuilder, REST, Routes } = require('discord.js');

// Define all slash commands
const commands = [
  // Betting System
  new SlashCommandBuilder()
    .setName('enterbetting')
    .setDescription('Register for the betting system'),
    
  new SlashCommandBuilder()
    .setName('createpool')
    .setDescription('Create a new betting pool')
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Pool title')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('description')
        .setDescription('Pool description')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option1')
        .setDescription('First betting option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option2')
        .setDescription('Second betting option')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('option3')
        .setDescription('Third betting option (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option4')
        .setDescription('Fourth betting option (optional)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('option5')
        .setDescription('Fifth betting option (optional)')
        .setRequired(false))
    .addIntegerOption(option =>
      option.setName('duration')
        .setDescription('Pool duration in hours')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(168)),
        
  new SlashCommandBuilder()
    .setName('resolvepool')
    .setDescription('Resolve a betting pool (Admin only)'),
    
  new SlashCommandBuilder()
    .setName('betlog')
    .setDescription('View your betting history')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('View another user\'s betting history (Admin only)')
        .setRequired(false)),
        
  new SlashCommandBuilder()
    .setName('viewpools')
    .setDescription('View active betting pools'),
    
  new SlashCommandBuilder()
    .setName('bet')
    .setDescription('Place a bet on an active pool')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount to bet')
        .setRequired(true)
        .setMinValue(1)),
        
  // Lending System
  new SlashCommandBuilder()
    .setName('lend')
    .setDescription('Lend points to another user')
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to lend')
        .setRequired(true)
        .setMinValue(1))
    .addNumberOption(option =>
      option.setName('interest')
        .setDescription('Interest rate (0.01 = 1%)')
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(0.25))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Number of days for repayment')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(30)),
        
  new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Pay back a loan')
    .addIntegerOption(option =>
      option.setName('loan_id')
        .setDescription('ID of the loan to repay')
        .setRequired(true)),
        
  new SlashCommandBuilder()
    .setName('extendloan')
    .setDescription('Extend loan duration')
    .addIntegerOption(option =>
      option.setName('loan_id')
        .setDescription('ID of the loan to extend')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Additional days to extend')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(14)),
        
  new SlashCommandBuilder()
    .setName('viewloans')
    .setDescription('View your active loans')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Type of loans to view')
        .setRequired(false)
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Borrowed', value: 'borrowed' },
          { name: 'Lent', value: 'lent' }
        )),
        
  // Bounty System
  new SlashCommandBuilder()
    .setName('bounty')
    .setDescription('Bounty system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('Create a new bounty')
        .addStringOption(option =>
          option.setName('title')
            .setDescription('Bounty title')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Bounty description')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('reward')
            .setDescription('Reward amount in points')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('claim')
        .setDescription('Claim a bounty as completed')
        .addIntegerOption(option =>
          option.setName('bounty_id')
            .setDescription('ID of the bounty to claim')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('proof')
            .setDescription('Proof of completion (optional)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View active bounties')),
        
  // Cash-in System
  new SlashCommandBuilder()
    .setName('cashin')
    .setDescription('Cash-in system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View available shop items')
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Filter by category')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('redeem')
        .setDescription('Redeem an item from the shop')
        .addIntegerOption(option =>
          option.setName('item_id')
            .setDescription('ID of the item to redeem')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('quantity')
            .setDescription('Quantity to redeem')
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(10))),
            
  // Points System
  new SlashCommandBuilder()
    .setName('points')
    .setDescription('Points system commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('view')
        .setDescription('View your points and stats')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('View another user\'s points')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('give')
        .setDescription('Give points to another user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to give')
            .setRequired(true)
            .setMinValue(1)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('daily')
        .setDescription('Claim your daily points bonus'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('interest')
        .setDescription('View interest calculations for lending')),
        
  // Leaderboard
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View various leaderboards')
    .addStringOption(option =>
      option.setName('type')
        .setDescription('Leaderboard type')
        .setRequired(false)
        .addChoices(
          { name: 'Points', value: 'points' },
          { name: 'Level', value: 'level' },
          { name: 'Total Earned', value: 'earned' },
          { name: 'Betting Wins', value: 'betting' }
        )),
        
  // Admin System
  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Admin commands')
    .addSubcommand(subcommand =>
      subcommand
        .setName('addshopitem')
        .setDescription('Add an item to the shop')
        .addStringOption(option =>
          option.setName('name')
            .setDescription('Item name')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('description')
            .setDescription('Item description')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('price')
            .setDescription('Item price in points')
            .setRequired(true)
            .setMinValue(1))
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Item category')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('stock')
            .setDescription('Stock quantity (-1 for unlimited)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('removeshopitem')
        .setDescription('Remove an item from the shop')
        .addIntegerOption(option =>
          option.setName('item_id')
            .setDescription('ID of the item to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('editshopitem')
        .setDescription('Edit a shop item'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('viewshop')
        .setDescription('View all shop items (including out of stock)'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('givepoints')
        .setDescription('Give points to a user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to give')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('removepoints')
        .setDescription('Remove points from a user')
        .addIntegerOption(option =>
          option.setName('amount')
            .setDescription('Amount of points to remove')
            .setRequired(true)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('viewuser')
        .setDescription('View detailed user information'))
    .addSubcommand(subcommand =>
      subcommand
        .setName('stats')
        .setDescription('View bot statistics')),
        
  // Help Command
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('View help information')
    .addStringOption(option =>
      option.setName('category')
        .setDescription('Help category')
        .setRequired(false)
        .addChoices(
          { name: 'Betting', value: 'betting' },
          { name: 'Lending', value: 'lending' },
          { name: 'Bounties', value: 'bounties' },
          { name: 'Shop', value: 'shop' },
          { name: 'Points', value: 'points' },
          { name: 'Admin', value: 'admin' }
        ))
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    // Register for specific guild (faster updates during development)
    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('✅ Successfully reloaded guild-specific commands.');
    } else {
      // Register globally (takes up to 1 hour to update)
      await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log('✅ Successfully reloaded global commands.');
    }
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
}

module.exports = { registerCommands };