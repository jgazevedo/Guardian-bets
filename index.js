const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { Pool } = require('pg');

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Initialize database tables
async function initDatabase() {
  try {
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id),
        amount INTEGER,
        option VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        lender_id VARCHAR(20),
        borrower_id VARCHAR(20),
        amount INTEGER,
        interest_rate DECIMAL(5,4),
        due_date TIMESTAMP,
        status VARCHAR(20) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bounties (
        id SERIAL PRIMARY KEY,
        creator_id VARCHAR(20),
        title VARCHAR(255),
        description TEXT,
        reward INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        winner_id VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shop_items (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        description TEXT,
        price INTEGER,
        category VARCHAR(100),
        in_stock BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_purchases (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        item_id INTEGER REFERENCES shop_items(id),
        quantity INTEGER DEFAULT 1,
        total_cost INTEGER,
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
    if (result.rows.length === 0) {
      // Create new user with 100 starting points
      await pool.query('INSERT INTO user_points (user_id, points) VALUES ($1, 100)', [userId]);
      return 100;
    }
    return result.rows[0].points;
  } catch (error) {
    console.error('Error getting user points:', error);
    return 0;
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(`
      INSERT INTO user_points (user_id, points) 
      VALUES ($1, $2) 
      ON CONFLICT (user_id) 
      DO UPDATE SET points = $2
    `, [userId, points]);
    return true;
  } catch (error) {
    console.error('Error updating user points:', error);
    return false;
  }
}

async function createBettingPool(title, description, creatorId) {
  try {
    const result = await pool.query(`
      INSERT INTO betting_pools (title, description, creator_id) 
      VALUES ($1, $2, $3) 
      RETURNING id
    `, [title, description, creatorId]);
    return result.rows[0].id;
  } catch (error) {
    console.error('Error creating betting pool:', error);
    return null;
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Admin user IDs
const adminUserIds = ["121564489043804161"];

function isAdmin(userId) {
  return adminUserIds.includes(userId);
}

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your current points balance'),
    
  new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily points bonus'),
    
  new SlashCommandBuilder()
    .setName('give')
    .setDescription('Give points to another user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to give points to')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('amount')
        .setDescription('Amount of points to give')
        .setRequired(true)
        .setMinValue(1)),
        
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('View the points leaderboard'),
    
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
        .setRequired(false)),
        
  // Lending system
  new SlashCommandBuilder()
    .setName('lend')
    .setDescription('Lend points to another user')
    .addUserOption(option =>
      option.setName('user')
        .setDescription('User to lend points to')
        .setRequired(true))
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
        .setMaxValue(0.1))
    .addIntegerOption(option =>
      option.setName('days')
        .setDescription('Number of days for repayment')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(30)),
        
  new SlashCommandBuilder()
    .setName('repay')
    .setDescription('Repay a loan')
    .addIntegerOption(option =>
      option.setName('loan_id')
        .setDescription('ID of the loan to repay')
        .setRequired(true)),
        
  new SlashCommandBuilder()
    .setName('loans')
    .setDescription('View your active loans'),
    
  // Bounty system
  new SlashCommandBuilder()
    .setName('createbounty')
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
        .setMinValue(1)),
        
  new SlashCommandBuilder()
    .setName('claimbounty')
    .setDescription('Claim a bounty as completed')
    .addIntegerOption(option =>
      option.setName('bounty_id')
        .setDescription('ID of the bounty to claim')
        .setRequired(true)),
        
  new SlashCommandBuilder()
    .setName('bounties')
    .setDescription('View active bounties'),
    
  // Shop system
  new SlashCommandBuilder()
    .setName('shop')
    .setDescription('View the points shop'),
    
  new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addIntegerOption(option =>
      option.setName('item_id')
        .setDescription('ID of the item to buy')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('quantity')
        .setDescription('Quantity to buy')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)),
        
  new SlashCommandBuilder()
    .setName('additem')
    .setDescription('Add an item to the shop (Admin only)')
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
];

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);
    
    console.log('🔄 Started refreshing application (/) commands.');
    
    // Your specific guild ID
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
  if (!interaction.isChatInputCommand()) return;

  const { commandName, user } = interaction;
  
  try {
    switch (commandName) {
      case 'balance': {
        const points = await getUserPoints(user.id);
        await interaction.reply({
          content: `💰 **${user.username}**, you have **${formatNumber(points)}** points!`,
          ephemeral: true
        });
        break;
      }
      
      case 'daily': {
        const currentPoints = await getUserPoints(user.id);
        const dailyBonus = 50;
        const newPoints = currentPoints + dailyBonus;
        
        await updateUserPoints(user.id, newPoints);
        
        await interaction.reply({
          content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`,
          ephemeral: true
        });
        break;
      }
      
      case 'give': {
        const targetUser = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        
        if (targetUser.id === user.id) {
          await interaction.reply({
            content: '❌ You cannot give points to yourself!',
            ephemeral: true
          });
          break;
        }
        
        const senderPoints = await getUserPoints(user.id);
        
        if (senderPoints < amount) {
          await interaction.reply({
            content: `❌ You don't have enough points! You have **${formatNumber(senderPoints)}** points.`,
            ephemeral: true
          });
          break;
        }
        
        const receiverPoints = await getUserPoints(targetUser.id);
        
        await updateUserPoints(user.id, senderPoints - amount);
        await updateUserPoints(targetUser.id, receiverPoints + amount);
        
        await interaction.reply({
          content: `✅ **${user.username}** gave **${formatNumber(amount)}** points to **${targetUser.username}**!`
        });
        break;
      }
      
      case 'leaderboard': {
        try {
          const result = await pool.query(`
            SELECT user_id, points 
            FROM user_points 
            ORDER BY points DESC 
            LIMIT 10
          `);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '📊 No users found in the leaderboard yet!',
              ephemeral: true
            });
            break;
          }
          
          let leaderboard = '🏆 **Points Leaderboard**\n\n';
          
          for (let i = 0; i < result.rows.length; i++) {
            const { user_id, points } = result.rows[i];
            const user = await client.users.fetch(user_id).catch(() => null);
            const username = user ? user.username : 'Unknown User';
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            
            leaderboard += `${medal} **${username}** - ${formatNumber(points)} points\n`;
          }
          
          await interaction.reply({
            content: leaderboard,
            ephemeral: true
          });
        } catch (error) {
          console.error('Leaderboard error:', error);
          await interaction.reply({
            content: '❌ Error fetching leaderboard!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'createpool': {
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description') || 'No description provided';
        
        const poolId = await createBettingPool(title, description, user.id);
        
        if (poolId) {
          await interaction.reply({
            content: `✅ **Betting pool created!**\n🎯 **Pool #${poolId}**: ${title}\n📝 ${description}`
          });
        } else {
          await interaction.reply({
            content: '❌ Failed to create betting pool!',
            ephemeral: true
          });
        }
        break;
      }
      
      // LENDING SYSTEM
      case 'lend': {
        const borrower = interaction.options.getUser('user');
        const amount = interaction.options.getInteger('amount');
        const interestRate = interaction.options.getNumber('interest');
        const days = interaction.options.getInteger('days');
        
        if (borrower.id === user.id) {
          await interaction.reply({
            content: '❌ You cannot lend points to yourself!',
            ephemeral: true
          });
          break;
        }
        
        const lenderPoints = await getUserPoints(user.id);
        
        if (lenderPoints < amount) {
          await interaction.reply({
            content: `❌ You don't have enough points! You have **${formatNumber(lenderPoints)}** points.`,
            ephemeral: true
          });
          break;
        }
        
        if (interestRate > 0.1) {
          await interaction.reply({
            content: '❌ Maximum interest rate is 10% (0.1)!',
            ephemeral: true
          });
          break;
        }
        
        // Calculate due date
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + days);
        
        try {
          // Create loan record
          const result = await pool.query(`
            INSERT INTO loans (lender_id, borrower_id, amount, interest_rate, due_date) 
            VALUES ($1, $2, $3, $4, $5) 
            RETURNING id
          `, [user.id, borrower.id, amount, interestRate, dueDate]);
          
          const loanId = result.rows[0].id;
          
          // Transfer points
          await updateUserPoints(user.id, lenderPoints - amount);
          const borrowerPoints = await getUserPoints(borrower.id);
          await updateUserPoints(borrower.id, borrowerPoints + amount);
          
          const totalRepayment = Math.floor(amount * (1 + interestRate));
          
          await interaction.reply({
            content: `✅ **Loan created!**\n💰 **Loan #${loanId}**\n👤 **Lender:** ${user.username}\n👤 **Borrower:** ${borrower.username}\n💵 **Amount:** ${formatNumber(amount)} points\n📈 **Interest:** ${(interestRate * 100).toFixed(2)}%\n💸 **Total to repay:** ${formatNumber(totalRepayment)} points\n📅 **Due:** ${dueDate.toDateString()}`
          });
        } catch (error) {
          console.error('Loan creation error:', error);
          await interaction.reply({
            content: '❌ Failed to create loan!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'repay': {
        const loanId = interaction.options.getInteger('loan_id');
        
        try {
          const result = await pool.query(`
            SELECT * FROM loans 
            WHERE id = $1 AND borrower_id = $2 AND status = 'active'
          `, [loanId, user.id]);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '❌ Loan not found or already repaid!',
              ephemeral: true
            });
            break;
          }
          
          const loan = result.rows[0];
          const totalRepayment = Math.floor(loan.amount * (1 + parseFloat(loan.interest_rate)));
          const borrowerPoints = await getUserPoints(user.id);
          
          if (borrowerPoints < totalRepayment) {
            await interaction.reply({
              content: `❌ You need **${formatNumber(totalRepayment)}** points to repay this loan! You have **${formatNumber(borrowerPoints)}** points.`,
              ephemeral: true
            });
            break;
          }
          
          // Process repayment
          await updateUserPoints(user.id, borrowerPoints - totalRepayment);
          const lenderPoints = await getUserPoints(loan.lender_id);
          await updateUserPoints(loan.lender_id, lenderPoints + totalRepayment);
          
          // Mark loan as repaid
          await pool.query(`
            UPDATE loans SET status = 'repaid' WHERE id = $1
          `, [loanId]);
          
          await interaction.reply({
            content: `✅ **Loan repaid!**\n💰 **Loan #${loanId}** has been successfully repaid!\n💸 **Amount paid:** ${formatNumber(totalRepayment)} points`
          });
        } catch (error) {
          console.error('Loan repayment error:', error);
          await interaction.reply({
            content: '❌ Failed to repay loan!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'loans': {
        try {
          const result = await pool.query(`
            SELECT l.*, u1.user_id as lender_name, u2.user_id as borrower_name
            FROM loans l
            LEFT JOIN user_points u1 ON l.lender_id = u1.user_id
            LEFT JOIN user_points u2 ON l.borrower_id = u2.user_id
            WHERE (l.lender_id = $1 OR l.borrower_id = $1) AND l.status = 'active'
            ORDER BY l.created_at DESC
          `, [user.id]);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '📋 You have no active loans.',
              ephemeral: true
            });
            break;
          }
          
          let loansList = '📋 **Your Active Loans**\n\n';
          
          for (const loan of result.rows) {
            const isLender = loan.lender_id === user.id;
            const otherUser = isLender ? 
              await client.users.fetch(loan.borrower_id).catch(() => ({ username: 'Unknown' })) :
              await client.users.fetch(loan.lender_id).catch(() => ({ username: 'Unknown' }));
            
            const totalRepayment = Math.floor(loan.amount * (1 + parseFloat(loan.interest_rate)));
            const dueDate = new Date(loan.due_date).toDateString();
            
            loansList += `💰 **Loan #${loan.id}**\n`;
            loansList += `${isLender ? '📤' : '📥'} ${isLender ? 'Lent to' : 'Borrowed from'}: ${otherUser.username}\n`;
            loansList += `💵 Amount: ${formatNumber(loan.amount)} points\n`;
            loansList += `💸 ${isLender ? 'Will receive' : 'Must repay'}: ${formatNumber(totalRepayment)} points\n`;
            loansList += `📅 Due: ${dueDate}\n\n`;
          }
          
          await interaction.reply({
            content: loansList,
            ephemeral: true
          });
        } catch (error) {
          console.error('Loans list error:', error);
          await interaction.reply({
            content: '❌ Error fetching loans!',
            ephemeral: true
          });
        }
        break;
      }
      
      // BOUNTY SYSTEM
      case 'createbounty': {
        const title = interaction.options.getString('title');
        const description = interaction.options.getString('description');
        const reward = interaction.options.getInteger('reward');
        
        const creatorPoints = await getUserPoints(user.id);
        
        if (creatorPoints < reward) {
          await interaction.reply({
            content: `❌ You don't have enough points! You have **${formatNumber(creatorPoints)}** points.`,
            ephemeral: true
          });
          break;
        }
        
        try {
          const result = await pool.query(`
            INSERT INTO bounties (creator_id, title, description, reward) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id
          `, [user.id, title, description, reward]);
          
          const bountyId = result.rows[0].id;
          
          // Deduct points from creator
          await updateUserPoints(user.id, creatorPoints - reward);
          
          await interaction.reply({
            content: `✅ **Bounty created!**\n🎯 **Bounty #${bountyId}**: ${title}\n📝 ${description}\n💰 **Reward:** ${formatNumber(reward)} points`
          });
        } catch (error) {
          console.error('Bounty creation error:', error);
          await interaction.reply({
            content: '❌ Failed to create bounty!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'claimbounty': {
        const bountyId = interaction.options.getInteger('bounty_id');
        
        try {
          const result = await pool.query(`
            SELECT * FROM bounties 
            WHERE id = $1 AND status = 'active'
          `, [bountyId]);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '❌ Bounty not found or already claimed!',
              ephemeral: true
            });
            break;
          }
          
          const bounty = result.rows[0];
          
          if (bounty.creator_id === user.id) {
            await interaction.reply({
              content: '❌ You cannot claim your own bounty!',
              ephemeral: true
            });
            break;
          }
          
          // Award bounty to claimer
          const claimerPoints = await getUserPoints(user.id);
          await updateUserPoints(user.id, claimerPoints + bounty.reward);
          
          // Mark bounty as completed
          await pool.query(`
            UPDATE bounties SET status = 'completed', winner_id = $1 WHERE id = $2
          `, [user.id, bountyId]);
          
          await interaction.reply({
            content: `✅ **Bounty claimed!**\n🎯 **Bounty #${bountyId}**: ${bounty.title}\n🏆 **Winner:** ${user.username}\n💰 **Reward:** ${formatNumber(bounty.reward)} points`
          });
        } catch (error) {
          console.error('Bounty claim error:', error);
          await interaction.reply({
            content: '❌ Failed to claim bounty!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'bounties': {
        try {
          const result = await pool.query(`
            SELECT * FROM bounties 
            WHERE status = 'active' 
            ORDER BY created_at DESC 
            LIMIT 10
          `);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '🎯 No active bounties available.',
              ephemeral: true
            });
            break;
          }
          
          let bountiesList = '🎯 **Active Bounties**\n\n';
          
          for (const bounty of result.rows) {
            const creator = await client.users.fetch(bounty.creator_id).catch(() => ({ username: 'Unknown' }));
            
            bountiesList += `🎯 **Bounty #${bounty.id}**\n`;
            bountiesList += `📝 **Title:** ${bounty.title}\n`;
            bountiesList += `📄 **Description:** ${bounty.description}\n`;
            bountiesList += `👤 **Creator:** ${creator.username}\n`;
            bountiesList += `💰 **Reward:** ${formatNumber(bounty.reward)} points\n`;
            bountiesList += `📅 **Created:** ${new Date(bounty.created_at).toDateString()}\n\n`;
          }
          
          await interaction.reply({
            content: bountiesList,
            ephemeral: true
          });
        } catch (error) {
          console.error('Bounties list error:', error);
          await interaction.reply({
            content: '❌ Error fetching bounties!',
            ephemeral: true
          });
        }
        break;
      }
      
      // SHOP SYSTEM
      case 'shop': {
        try {
          const result = await pool.query(`
            SELECT * FROM shop_items 
            WHERE in_stock = true 
            ORDER BY category, price ASC
          `);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '🛒 The shop is currently empty.',
              ephemeral: true
            });
            break;
          }
          
          let shopList = '🛒 **Points Shop**\n\n';
          let currentCategory = '';
          
          for (const item of result.rows) {
            if (item.category !== currentCategory) {
              currentCategory = item.category || 'Other';
              shopList += `**${currentCategory}**\n`;
            }
            
            shopList += `🆔 **${item.id}** - ${item.name}\n`;
            shopList += `📝 ${item.description}\n`;
            shopList += `💰 **${formatNumber(item.price)}** points\n\n`;
          }
          
          shopList += `💡 Use \`/buy item_id:X\` to purchase an item!`;
          
          await interaction.reply({
            content: shopList,
            ephemeral: true
          });
        } catch (error) {
          console.error('Shop error:', error);
          await interaction.reply({
            content: '❌ Error loading shop!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'buy': {
        const itemId = interaction.options.getInteger('item_id');
        const quantity = interaction.options.getInteger('quantity') || 1;
        
        try {
          const result = await pool.query(`
            SELECT * FROM shop_items 
            WHERE id = $1 AND in_stock = true
          `, [itemId]);
          
          if (result.rows.length === 0) {
            await interaction.reply({
              content: '❌ Item not found or out of stock!',
              ephemeral: true
            });
            break;
          }
          
          const item = result.rows[0];
          const totalCost = item.price * quantity;
          const userPoints = await getUserPoints(user.id);
          
          if (userPoints < totalCost) {
            await interaction.reply({
              content: `❌ You need **${formatNumber(totalCost)}** points to buy ${quantity}x ${item.name}! You have **${formatNumber(userPoints)}** points.`,
              ephemeral: true
            });
            break;
          }
          
          // Process purchase
          await updateUserPoints(user.id, userPoints - totalCost);
          
          // Record purchase
          await pool.query(`
            INSERT INTO user_purchases (user_id, item_id, quantity, total_cost) 
            VALUES ($1, $2, $3, $4)
          `, [user.id, itemId, quantity, totalCost]);
          
          await interaction.reply({
            content: `✅ **Purchase successful!**\n🛒 You bought **${quantity}x ${item.name}**\n💰 **Cost:** ${formatNumber(totalCost)} points\n💳 **Remaining balance:** ${formatNumber(userPoints - totalCost)} points`
          });
        } catch (error) {
          console.error('Purchase error:', error);
          await interaction.reply({
            content: '❌ Failed to complete purchase!',
            ephemeral: true
          });
        }
        break;
      }
      
      case 'additem': {
        if (!isAdmin(user.id)) {
          await interaction.reply({
            content: '❌ Only admins can add items to the shop!',
            ephemeral: true
          });
          break;
        }
        
        const name = interaction.options.getString('name');
        const description = interaction.options.getString('description');
        const price = interaction.options.getInteger('price');
        const category = interaction.options.getString('category') || 'Other';
        
        try {
          const result = await pool.query(`
            INSERT INTO shop_items (name, description, price, category) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id
          `, [name, description, price, category]);
          
          const itemId = result.rows[0].id;
          
          await interaction.reply({
            content: `✅ **Item added to shop!**\n🆔 **Item #${itemId}**: ${name}\n📝 ${description}\n💰 **Price:** ${formatNumber(price)} points\n📂 **Category:** ${category}`
          });
        } catch (error) {
          console.error('Add item error:', error);
          await interaction.reply({
            content: '❌ Failed to add item to shop!',
            ephemeral: true
          });
        }
        break;
      }
      
      default:
        await interaction.reply({
          content: '❌ Unknown command!',
          ephemeral: true
        });
    }
  } catch (error) {
    console.error('Command error:', error);
    await interaction.reply({
      content: '❌ An error occurred while processing your command!',
      ephemeral: true
    });
  }
});

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🔄 Shutting down...');
  await pool.end();
  client.destroy();
  process.exit(0);

console.log('Token length:', process.env.DISCORD_BOT_TOKEN?.length);
console.log('Token starts with:', process.env.DISCORD_BOT_TOKEN?.substring(0, 10));

});


