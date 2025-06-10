const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  EmbedBuilder,
} = require("discord.js")
const { Pool } = require("pg")

// Database setup
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
})

// Initialize database tables
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_points (
        user_id VARCHAR(20) PRIMARY KEY,
        points INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

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
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS pool_options (
        id SERIAL PRIMARY KEY,
        pool_id INTEGER REFERENCES betting_pools(id) ON DELETE CASCADE,
        option_text VARCHAR(255),
        emoji VARCHAR(10),
        is_correct BOOLEAN DEFAULT FALSE
      )
    `)

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_bets (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(20),
        pool_id INTEGER REFERENCES betting_pools(id) ON DELETE CASCADE,
        option_id INTEGER REFERENCES pool_options(id) ON DELETE CASCADE,
        amount INTEGER,
        locked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Add unique constraint if it doesn't exist
    try {
      await pool.query(`
        ALTER TABLE user_bets 
        ADD CONSTRAINT user_bets_user_pool_unique 
        UNIQUE (user_id, pool_id)
      `)
      console.log("✅ Added unique constraint to user_bets table")
    } catch (error) {
      if (error.code === "42P07") {
        console.log("✅ Unique constraint already exists")
      } else {
        console.error("Error adding unique constraint:", error)
      }
    }

    console.log("✅ Database initialized successfully")
  } catch (error) {
    console.error("❌ Database initialization failed:", error)
  }
}

// Database helper functions
async function getUserPoints(userId) {
  try {
    const result = await pool.query("SELECT points FROM user_points WHERE user_id = $1", [userId])
    if (result.rows.length === 0) return null
    return result.rows[0].points
  } catch (error) {
    console.error("Error getting user points:", error)
    return null
  }
}

async function registerUser(userId) {
  try {
    const result = await pool.query(
      `INSERT INTO user_points (user_id, points) VALUES ($1, 1000) 
       ON CONFLICT (user_id) DO NOTHING RETURNING points`,
      [userId],
    )
    return result.rows.length > 0
  } catch (error) {
    console.error("Error registering user:", error)
    return false
  }
}

async function updateUserPoints(userId, points) {
  try {
    await pool.query(
      `INSERT INTO user_points (user_id, points) VALUES ($1, $2) 
       ON CONFLICT (user_id) DO UPDATE SET points = $2`,
      [userId, points],
    )
    return true
  } catch (error) {
    console.error("Error updating user points:", error)
    return false
  }
}

async function createPool(creatorId, title, description, options) {
  try {
    const result = await pool.query(
      "INSERT INTO betting_pools (creator_id, title, description) VALUES ($1, $2, $3) RETURNING id",
      [creatorId, title, description],
    )
    const poolId = result.rows[0].id

    for (const { text, emoji } of options) {
      await pool.query("INSERT INTO pool_options (pool_id, option_text, emoji) VALUES ($1, $2, $3)", [
        poolId,
        text || "Option",
        emoji || "",
      ])
    }
    return poolId
  } catch (error) {
    console.error("Error creating pool:", error)
    return null
  }
}

async function getOpenPools(creatorId) {
  try {
    return await pool.query("SELECT id, title, description FROM betting_pools WHERE status = $1", ["active"])
  } catch (error) {
    console.error("Error getting open pools:", error)
    return { rows: [] }
  }
}

async function getPoolOptions(poolId) {
  try {
    return await pool.query("SELECT id, option_text, emoji FROM pool_options WHERE pool_id = $1", [poolId])
  } catch (error) {
    console.error("Error getting pool options:", error)
    return { rows: [] }
  }
}

async function getUserBet(userId, poolId) {
  try {
    const result = await pool.query(
      `SELECT ub.*, po.option_text, po.emoji 
       FROM user_bets ub 
       JOIN pool_options po ON ub.option_id = po.id 
       WHERE ub.user_id = $1 AND ub.pool_id = $2`,
      [userId, poolId],
    )
    return result.rows[0] || null
  } catch (error) {
    console.error("Error getting user bet:", error)
    return null
  }
}

async function recordBet(userId, poolId, optionId, amount) {
  try {
    // Check if user already has a bet on this pool
    const existingBet = await getUserBet(userId, poolId)

    if (existingBet) {
      // Update existing bet
      await pool.query(
        `UPDATE user_bets 
         SET option_id = $1, amount = $2, locked_at = NULL, created_at = CURRENT_TIMESTAMP 
         WHERE user_id = $3 AND pool_id = $4`,
        [optionId, amount, userId, poolId],
      )

      // Refund previous bet amount and charge new amount
      const currentPoints = await getUserPoints(userId)
      const pointsDifference = amount - existingBet.amount
      await updateUserPoints(userId, currentPoints - pointsDifference)
    } else {
      // Insert new bet
      await pool.query(
        `INSERT INTO user_bets (user_id, pool_id, option_id, amount, locked_at) 
         VALUES ($1, $2, $3, $4, NULL)`,
        [userId, poolId, optionId, amount],
      )

      // Deduct points for new bet
      const currentPoints = await getUserPoints(userId)
      await updateUserPoints(userId, currentPoints - amount)
    }

    return true
  } catch (error) {
    console.error("Error recording bet:", error)
    return false
  }
}

async function lockBet(userId, poolId) {
  try {
    const result = await pool.query(
      "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL RETURNING *",
      [userId, poolId],
    )
    console.log(`Locked bet for user ${userId} on pool ${poolId}`)
    return result.rows.length > 0
  } catch (error) {
    console.error("Error locking bet:", error)
    return false
  }
}

async function cancelBet(userId, poolId) {
  try {
    const result = await pool.query(
      "DELETE FROM user_bets WHERE user_id = $1 AND pool_id = $2 AND locked_at IS NULL RETURNING amount",
      [userId, poolId],
    )

    if (result.rows.length > 0) {
      // Refund points
      const refundAmount = result.rows[0].amount
      const currentPoints = await getUserPoints(userId)
      await updateUserPoints(userId, currentPoints + refundAmount)
      return refundAmount
    }
    return 0
  } catch (error) {
    console.error("Error canceling bet:", error)
    return 0
  }
}

async function closePool(poolId, correctOptionId) {
  try {
    console.log(`Closing pool ${poolId} with correct option ${correctOptionId}`)

    // First, lock all unlocked bets for this pool
    const lockResult = await pool.query(
      "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE pool_id = $1 AND locked_at IS NULL RETURNING user_id, amount",
      [poolId],
    )
    console.log(`Locked ${lockResult.rows.length} bets before closing pool`)

    // Close the pool
    await pool.query("UPDATE betting_pools SET status = $1 WHERE id = $2", ["closed", poolId])

    // Mark the correct option
    await pool.query("UPDATE pool_options SET is_correct = TRUE WHERE id = $1", [correctOptionId])

    // Get all locked bets for this pool
    const allBets = await pool.query(
      `SELECT ub.user_id, ub.amount, ub.option_id, po.option_text
       FROM user_bets ub 
       JOIN pool_options po ON ub.option_id = po.id
       WHERE ub.pool_id = $1 AND ub.locked_at IS NOT NULL`,
      [poolId],
    )

    console.log(`Found ${allBets.rows.length} locked bets for pool ${poolId}`)

    if (allBets.rows.length === 0) {
      console.log("No locked bets found")
      return true
    }

    // Get winning bets
    const winningBets = allBets.rows.filter((bet) => bet.option_id == correctOptionId)
    console.log(`Found ${winningBets.length} winning bets`)

    if (winningBets.length === 0) {
      console.log("No winning bets - house keeps all")
      return true
    }

    // Calculate totals
    const totalStaked = allBets.rows.reduce((sum, bet) => sum + bet.amount, 0)
    const totalWinningStake = winningBets.reduce((sum, bet) => sum + bet.amount, 0)
    const totalPayout = Math.floor(totalStaked * 0.9) // 90% payout, 10% house cut

    console.log(`Total staked: ${totalStaked}, Total winning stake: ${totalWinningStake}, Total payout: ${totalPayout}`)

    // Distribute winnings
    for (const bet of winningBets) {
      const rewardRatio = bet.amount / totalWinningStake
      const reward = Math.floor(totalPayout * rewardRatio)

      const currentPoints = (await getUserPoints(bet.user_id)) || 0
      await updateUserPoints(bet.user_id, currentPoints + reward)

      console.log(
        `Awarded ${reward} points to user ${bet.user_id} (bet: ${bet.amount}, ratio: ${rewardRatio.toFixed(3)})`,
      )
    }

    return true
  } catch (error) {
    console.error("Error closing pool:", error)
    return false
  }
}

// Utility functions
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

function parseOptionText(optionText) {
  const emojiRegex =
    /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu
  const emojis = optionText.match(emojiRegex)
  const text = optionText.replace(emojiRegex, "").trim()

  return {
    text: text || "Option",
    emoji: emojis ? emojis[0] : null,
  }
}

// Admin user IDs
const adminUserIds = ["121564489043804161"]

// Check if user is an admin
function isAdmin(userId, member) {
  const hasAdminPermission = member.permissions.has(PermissionFlagsBits.Administrator)
  const isHardcodedAdmin = adminUserIds.includes(userId)
  return hasAdminPermission || isHardcodedAdmin
}

// Pool state management
const activePools = new Map()
const betTimeouts = new Map()

// Discord bot setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
})

// Slash commands
const commands = [
  new SlashCommandBuilder().setName("daily").setDescription("Claim your daily points bonus"),
  new SlashCommandBuilder().setName("participate").setDescription("Join the bot and receive 1000 starting points"),
  new SlashCommandBuilder().setName("wallet").setDescription("Check your current points balance"),
  new SlashCommandBuilder().setName("mybets").setDescription("View your current active bets"),
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add points to a user (Admin only)")
    .addUserOption((option) => option.setName("user").setDescription("The user to add points to").setRequired(true))
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Amount of points to add")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove points from a user (Admin only)")
    .addUserOption((option) =>
      option.setName("user").setDescription("The user to remove points from").setRequired(true),
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("Amount of points to remove")
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(999999),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName("create").setDescription("Create a new betting pool"),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close a betting pool and select the correct answer (Admin or creator only)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
]

// Register slash commands
async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN)
    console.log("🔄 Started refreshing application (/) commands.")
    await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: [] })
    console.log("✅ Cleared global commands.")
    await rest.put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, "979180991836995674"), {
      body: commands,
    })
    console.log("✅ Successfully reloaded guild-specific commands (instant update).")
  } catch (error) {
    console.error("❌ Error registering commands:", error)
  }
}

// Bot event handlers
client.once("ready", async () => {
  console.log(`✅ Bot is ready! Logged in as ${client.user.tag}`)
  await initDatabase()
  await registerCommands()
})

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    const { commandName, user, member } = interaction
    try {
      console.log(`Command: ${commandName}, User: ${user.id}`)

      switch (commandName) {
        case "daily": {
          const currentPoints = await getUserPoints(user.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }
          const dailyBonus = 100
          const newPoints = currentPoints + dailyBonus
          await updateUserPoints(user.id, newPoints)
          await interaction.reply({
            content: `🎁 **Daily bonus claimed!** You received **${dailyBonus}** points!\n💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "participate": {
          const isNewUser = await registerUser(user.id)
          if (isNewUser) {
            await interaction.reply({
              content: `✅ **Welcome!** You've joined the bot and received **1000** starting points!`,
              flags: MessageFlags.Ephemeral,
            })
          } else {
            await interaction.reply({
              content: `❌ You've already joined the bot! Use /wallet to check your balance.`,
              flags: MessageFlags.Ephemeral,
            })
          }
          break
        }

        case "wallet": {
          const points = await getUserPoints(user.id)
          if (points === null) {
            await interaction.reply({
              content: `❌ You haven't joined yet! Use /participate to start with 1000 points.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }
          await interaction.reply({
            content: `💰 **${user.username}**, your current balance is **${formatNumber(points)}** points!`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "mybets": {
          const userPoints = await getUserPoints(user.id)
          if (userPoints === null) {
            await interaction.reply({
              content: "❌ You must use `/participate` first to join the bot!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const activeBets = await pool.query(
            `SELECT ub.*, bp.title, po.option_text, po.emoji, bp.status
             FROM user_bets ub
             JOIN betting_pools bp ON ub.pool_id = bp.id
             JOIN pool_options po ON ub.option_id = po.id
             WHERE ub.user_id = $1 AND bp.status = 'active'
             ORDER BY ub.created_at DESC`,
            [user.id],
          )

          if (activeBets.rows.length === 0) {
            await interaction.reply({
              content: "📊 You have no active bets right now.",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const embed = new EmbedBuilder()
            .setTitle("📊 Your Active Bets")
            .setColor(0x00ae86)
            .setFooter({ text: `Balance: ${formatNumber(userPoints)} points` })

          for (const bet of activeBets.rows) {
            const status = bet.locked_at ? "🔒 Locked" : "⏰ Can change (30s)"
            embed.addFields({
              name: bet.title,
              value: `**Bet:** ${formatNumber(bet.amount)} points on "${bet.option_text}" ${bet.emoji || ""}\n**Status:** ${status}`,
              inline: false,
            })
          }

          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
          break
        }

        case "create": {
          const modal = new ModalBuilder().setCustomId("create_pool_modal").setTitle("Create Betting Pool")

          const titleInput = new TextInputBuilder()
            .setCustomId("pool_title")
            .setLabel("Pool Title")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("Enter a title for your betting pool")
            .setRequired(true)

          const descriptionInput = new TextInputBuilder()
            .setCustomId("pool_description")
            .setLabel("Description")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("Describe what this pool is about")
            .setRequired(true)

          const option1Input = new TextInputBuilder()
            .setCustomId("option_1")
            .setLabel("Option 1 (text + emoji)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Yes 👍")
            .setRequired(true)

          const option2Input = new TextInputBuilder()
            .setCustomId("option_2")
            .setLabel("Option 2 (text + emoji)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., No 👎")
            .setRequired(true)

          const option3Input = new TextInputBuilder()
            .setCustomId("option_3")
            .setLabel("Option 3 (text + emoji)")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder("e.g., Maybe 🤔")
            .setRequired(false)

          modal.addComponents(
            new ActionRowBuilder().addComponents(titleInput),
            new ActionRowBuilder().addComponents(descriptionInput),
            new ActionRowBuilder().addComponents(option1Input),
            new ActionRowBuilder().addComponents(option2Input),
            new ActionRowBuilder().addComponents(option3Input),
          )

          await interaction.showModal(modal)
          break
        }

        case "add": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or have specific admin clearance to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const targetUser = interaction.options.getUser("user")
          const amount = interaction.options.getInteger("amount")

          const currentPoints = await getUserPoints(targetUser.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: `❌ User ${targetUser} has not joined yet! They must use /participate first.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const newPoints = currentPoints + amount
          await updateUserPoints(targetUser.id, newPoints)

          await interaction.reply({
            content: `✅ Added **${formatNumber(amount)}** points to ${targetUser}!\n💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "remove": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or have specific admin clearance to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const targetUser = interaction.options.getUser("user")
          const amount = interaction.options.getInteger("amount")

          const currentPoints = await getUserPoints(targetUser.id)
          if (currentPoints === null) {
            await interaction.reply({
              content: `❌ User ${targetUser} has not joined yet! They must use /participate first.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          if (currentPoints < amount) {
            await interaction.reply({
              content: `❌ User ${targetUser} only has **${formatNumber(currentPoints)}** points! Cannot remove **${formatNumber(amount)}** points.`,
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const newPoints = currentPoints - amount
          await updateUserPoints(targetUser.id, newPoints)

          await interaction.reply({
            content: `✅ Removed **${formatNumber(amount)}** points from ${targetUser}!\n💰 New balance: **${formatNumber(newPoints)}** points`,
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        case "close": {
          if (!isAdmin(user.id, member)) {
            await interaction.reply({
              content: "❌ You must be a server administrator or the pool creator to use this command!",
              flags: MessageFlags.Ephemeral,
            })
            break
          }

          const pools = await getOpenPools(user.id)
          if (pools.rows.length === 0) {
            await interaction.reply({ content: "❌ No open pools available to close.", flags: MessageFlags.Ephemeral })
            break
          }

          const poolSelect = new StringSelectMenuBuilder()
            .setCustomId("pool_select")
            .setPlaceholder("Select a pool to close")
            .addOptions(
              pools.rows.map((pool) => ({
                label: pool.title.substring(0, 100),
                value: pool.id.toString(),
                description: pool.description.substring(0, 100),
              })),
            )

          const row = new ActionRowBuilder().addComponents(poolSelect)
          await interaction.reply({
            content: "Select a pool to close:",
            components: [row],
            flags: MessageFlags.Ephemeral,
          })
          break
        }

        default:
          await interaction.reply({ content: "❌ Unknown command!", flags: MessageFlags.Ephemeral })
      }
    } catch (error) {
      console.error("Command error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your command!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isModalSubmit()) {
    try {
      const { customId, fields } = interaction
      console.log(`Modal submit: ${customId}`)

      if (customId === "create_pool_modal") {
        const title = fields.getTextInputValue("pool_title")
        const description = fields.getTextInputValue("pool_description")

        const options = []

        // Process required options
        for (let i = 1; i <= 2; i++) {
          const optionText = fields.getTextInputValue(`option_${i}`)
          if (optionText) {
            const parsed = parseOptionText(optionText)
            options.push(parsed)
          }
        }

        // Process optional third option
        try {
          const option3Text = fields.getTextInputValue("option_3")
          if (option3Text && option3Text.trim()) {
            const parsed = parseOptionText(option3Text)
            options.push(parsed)
          }
        } catch (e) {
          // Option 3 is optional, so ignore if not provided
        }

        if (options.length < 2) {
          await interaction.reply({
            content: "❌ Please provide at least 2 options for the betting pool.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const poolId = await createPool(interaction.user.id, title, description, options)
        if (!poolId) {
          await interaction.reply({
            content: "❌ Failed to create pool. Please try again.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Create betting buttons
        const buttons = options.map((opt, i) => {
          const button = new ButtonBuilder()
            .setCustomId(`bet_${poolId}_${i}`)
            .setLabel(opt.text)
            .setStyle(ButtonStyle.Primary)
          if (opt.emoji) {
            button.setEmoji(opt.emoji)
          }
          return button
        })

        const row = new ActionRowBuilder().addComponents(buttons)

        // Send the pool message
        const channel = interaction.channel
        const poolMessage = await channel.send({
          content: `🎲 **${title}**\n${description}\n\n*Created by <@${interaction.user.id}> • Betting closes in 5 minutes*`,
          components: [row],
        })

        // Update database with message info
        await pool.query("UPDATE betting_pools SET message_id = $1, channel_id = $2 WHERE id = $3", [
          poolMessage.id,
          channel.id,
          poolId,
        ])

        // Store active pool info
        activePools.set(poolId, {
          messageId: poolMessage.id,
          channelId: channel.id,
        })

        // Set timeout to lock all bets after 5 minutes (but keep pool open for manual closure)
        setTimeout(
          async () => {
            try {
              // Lock all unlocked bets for this pool
              const lockResult = await pool.query(
                "UPDATE user_bets SET locked_at = CURRENT_TIMESTAMP WHERE pool_id = $1 AND locked_at IS NULL RETURNING user_id, amount",
                [poolId],
              )
              console.log(`Auto-locked ${lockResult.rows.length} bets for pool ${poolId} after 5 minutes`)

              // Update the message to show betting is closed but pool is still open
              const message = await channel.messages.fetch(poolMessage.id)
              await message.edit({
                content: `🎲 **${title}** *(BETTING CLOSED)*\n${description}\n\n*Created by <@${interaction.user.id}> • Betting closed, awaiting manual pool closure*`,
                components: [], // Remove betting buttons
              })
            } catch (error) {
              console.error("Error auto-locking bets:", error)
            }
          },
          5 * 60 * 1000,
        ) // 5 minutes

        await interaction.reply({
          content: `✅ Pool "${title}" created successfully! Betting will close in 5 minutes, but the pool will remain open for manual closure.`,
          flags: MessageFlags.Ephemeral,
        })
      } else if (customId.startsWith("bet_confirm_")) {
        const parts = customId.split("_")
        const poolId = Number.parseInt(parts[2])
        const optionIndex = Number.parseInt(parts[3])

        const stake = Number.parseInt(fields.getTextInputValue("stake"))
        const userId = interaction.user.id

        if (isNaN(stake) || stake < 10 || stake > 999999) {
          await interaction.reply({
            content: "❌ Invalid stake amount! Must be between 10 and 999,999 points.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const currentPoints = await getUserPoints(userId)
        if (currentPoints === null) {
          await interaction.reply({
            content: "❌ You must use `/participate` first to join the bot!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Check if user has existing bet
        const existingBet = await getUserBet(userId, poolId)

        // Calculate the actual cost difference
        let totalCost
        if (existingBet) {
          totalCost = stake - existingBet.amount // Difference between new and old bet
        } else {
          totalCost = stake // Full amount for new bet
        }

        if (currentPoints < totalCost) {
          const needed = totalCost - currentPoints
          await interaction.reply({
            content: `❌ Insufficient points! You need **${formatNumber(needed)}** more points.`,
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const optionsResult = await getPoolOptions(poolId)
        if (!optionsResult.rows.length || !optionsResult.rows[optionIndex]) {
          await interaction.reply({
            content: "❌ Invalid option selected.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        const optionId = optionsResult.rows[optionIndex].id
        const success = await recordBet(userId, poolId, optionId, stake)

        if (success) {
          // Only set a timeout if one doesn't already exist for this user and pool
          const timeoutKey = `${userId}_${poolId}`
          if (!betTimeouts.has(timeoutKey)) {
            betTimeouts.set(
              timeoutKey,
              setTimeout(() => {
                lockBet(userId, poolId)
                betTimeouts.delete(timeoutKey)
              }, 30 * 1000),
            )
          }

          const actionText = existingBet ? "updated" : "placed"
          await interaction.reply({
            content: `✅ Bet ${actionText}! **${formatNumber(stake)}** points on "${optionsResult.rows[optionIndex].option_text}"!\n⏰ You have 30 seconds to change or cancel this bet.`,
            flags: MessageFlags.Ephemeral,
          })
        } else {
          await interaction.reply({
            content: "❌ Failed to place bet. Please try again.",
            flags: MessageFlags.Ephemeral,
          })
        }
      }
    } catch (error) {
      console.error("Modal submission error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your request!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isButton()) {
    try {
      console.log(`Button clicked: ${interaction.customId}`)
      const [action, poolId, optionIndex] = interaction.customId.split("_")

      if (action === "bet") {
        const poolIdInt = Number.parseInt(poolId)
        const optionIndexInt = Number.parseInt(optionIndex)

        console.log(`Bet button - Pool ID: ${poolIdInt}, Option Index: ${optionIndexInt}`)

        // Check if pool is still active
        const poolResult = await pool.query("SELECT * FROM betting_pools WHERE id = $1 AND status = $2", [
          poolIdInt,
          "active",
        ])

        if (!poolResult.rows.length) {
          await interaction.reply({
            content: "❌ This pool is closed or does not exist.",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Check if user is registered
        const userPoints = await getUserPoints(interaction.user.id)
        if (userPoints === null) {
          await interaction.reply({
            content: "❌ You must use `/participate` first to join the bot!",
            flags: MessageFlags.Ephemeral,
          })
          return
        }

        // Check existing bet
        const existingBet = await getUserBet(interaction.user.id, poolIdInt)

        const modal = new ModalBuilder()
          .setCustomId(`bet_confirm_${poolIdInt}_${optionIndexInt}`)
          .setTitle(existingBet ? "Update Your Bet" : "Place Your Bet")

        const stakeInput = new TextInputBuilder()
          .setCustomId("stake")
          .setLabel("Stake Amount")
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`Enter points to stake (min: 10, max: ${formatNumber(userPoints)})`)
          .setRequired(true)

        if (existingBet) {
          stakeInput.setValue(existingBet.amount.toString())
        }

        modal.addComponents(new ActionRowBuilder().addComponents(stakeInput))

        console.log(`Showing betting modal for pool ${poolIdInt}, option ${optionIndexInt}`)
        await interaction.showModal(modal)
      } else if (action === "cancel") {
        const poolIdInt = Number.parseInt(poolId)
        const refund = await cancelBet(interaction.user.id, poolIdInt)

        if (refund > 0) {
          await interaction.reply({
            content: `✅ Bet cancelled! **${formatNumber(refund)}** points refunded.`,
            flags: MessageFlags.Ephemeral,
          })
        } else {
          await interaction.reply({
            content: "❌ No active bet found or bet is already locked.",
            flags: MessageFlags.Ephemeral,
          })
        }
      }
    } catch (error) {
      console.error("Button interaction error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your bet!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  } else if (interaction.isStringSelectMenu()) {
    try {
      if (interaction.customId === "pool_select") {
        const poolId = interaction.values[0]
        const optionsResult = await getPoolOptions(poolId)

        if (!optionsResult.rows.length) {
          await interaction.update({
            content: "❌ No options available for this pool.",
            components: [],
          })
          return
        }

        const optionSelect = new StringSelectMenuBuilder()
          .setCustomId(`close_pool_${poolId}`)
          .setPlaceholder("Select the correct answer")
          .addOptions(
            optionsResult.rows.map((opt, i) => ({
              label: opt.option_text,
              value: opt.id.toString(),
              description: `Option ${i + 1}${opt.emoji ? ` ${opt.emoji}` : ""}`,
              emoji: opt.emoji || undefined,
            })),
          )

        const row = new ActionRowBuilder().addComponents(optionSelect)
        await interaction.update({
          content: "Select the correct answer to close the pool:",
          components: [row],
        })
      } else if (interaction.customId.startsWith("close_pool_")) {
        const poolId = interaction.customId.split("_")[2]
        const correctOptionId = Number.parseInt(interaction.values[0])

        const success = await closePool(poolId, correctOptionId)

        if (success) {
          // Update the original pool message if possible
          const poolInfo = activePools.get(Number.parseInt(poolId))
          if (poolInfo) {
            try {
              const channel = await client.channels.fetch(poolInfo.channelId)
              const message = await channel.messages.fetch(poolInfo.messageId)
              await message.edit({
                content: message.content.replace("Pool closes in", "Pool closed -"),
                components: [],
              })
            } catch (error) {
              console.error("Error updating pool message:", error)
            }
            activePools.delete(Number.parseInt(poolId))
          }

          await interaction.update({
            content: `✅ Pool ${poolId} has been closed and points have been distributed to winners!`,
            components: [],
          })
        } else {
          await interaction.update({
            content: "❌ Failed to close pool. Please try again.",
            components: [],
          })
        }
      }
    } catch (error) {
      console.error("Select menu error:", error.stack)
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: "❌ An error occurred while processing your selection!",
          flags: MessageFlags.Ephemeral,
        })
      }
    }
  }
})

console.log("Token length:", process.env.DISCORD_BOT_TOKEN?.length)

// Start the bot
client.login(process.env.DISCORD_BOT_TOKEN)

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("🔄 Shutting down...")
  await pool.end()
  client.destroy()
  process.exit(0)
})
