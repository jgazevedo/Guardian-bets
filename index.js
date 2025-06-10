const express = require("express")
const { InteractionType, InteractionResponseType, verifyKeyMiddleware } = require("discord-interactions")

// Create an express app
const app = express()
const PORT = process.env.PORT || 3000

// Railway middleware - trust proxy
app.set('trust proxy', 1)

// Parse JSON body
app.use(express.json({ limit: '1mb' }))

// Request logging for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`)
  next()
})

// In-memory databases (in production, use your Neon database)
const users = {}
const bettingPools = {}
const loans = {}
const bounties = {}
const shopItems = {
  1: { id: 1, name: "Lucky Charm", description: "Increases your luck for next bet", price: 500, requiresTarget: false },
  2: { id: 2, name: "Point Boost", description: "Give someone 200 bonus points", price: 300, requiresTarget: true },
  3: { id: 3, name: "Debt Forgiveness", description: "Forgive someone's loan", price: 1000, requiresTarget: true },
}
let poolIdCounter = 1
let loanIdCounter = 1
let bountyIdCounter = 1 // Fixed: was const, now let

// System settings
const systemSettings = {
  maxInterestRate: 50.0,
}

// Helper functions
function ensureUser(userId, username) {
  if (!users[userId]) {
    users[userId] = {
      username,
      points: 0,
      isRegistered: false,
      lastDailyClaim: null,
      bets: [],
      loans: [],
    }
  }
}

function canClaimDaily(userId) {
  if (!users[userId].lastDailyClaim) return true
  const lastClaim = new Date(users[userId].lastDailyClaim)
  const now = new Date()
  const timeDiff = now - lastClaim
  return timeDiff >= 24 * 60 * 60 * 1000 // 24 hours
}

// Health check endpoint (Railway needs this)
app.get("/", (req, res) => {
  res.json({
    status: "healthy",
    message: "Discord bot is running!",
    timestamp: new Date().toISOString(),
    port: PORT
  })
})

// Additional health check for Railway
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" })
})

// Simple GET endpoint for testing
app.get("/api/discord", (req, res) => {
  console.log("GET request received")
  res.json({
    message: "Discord bot endpoint is running!",
    timestamp: new Date().toISOString(),
  })
})

// Discord interactions endpoint with verification
app.post("/api/discord", (req, res, next) => {
  // Check if DISCORD_PUBLIC_KEY is available
  if (!process.env.DISCORD_PUBLIC_KEY) {
    console.error("DISCORD_PUBLIC_KEY environment variable is not set")
    return res.status(500).json({ error: "Server configuration error" })
  }
  
  // Apply verification middleware
  verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY)(req, res, next)
}, (req, res) => {
  console.log("Verified Discord request received")

  const interaction = req.body

  if (interaction.type === InteractionType.PING) {
    console.log("Responding to Discord ping")
    return res.json({
      type: InteractionResponseType.PONG,
    })
  }

  if (interaction.type === InteractionType.APPLICATION_COMMAND) {
    return handleSlashCommand(interaction, res)
  }

  if (interaction.type === InteractionType.MESSAGE_COMPONENT) {
    return handleButtonClick(interaction, res)
  }

  if (interaction.type === InteractionType.MODAL_SUBMIT) {
    return handleModalSubmit(interaction, res)
  }

  // Default response
  return res.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: "Unknown interaction type",
    },
  })
})

function handleSlashCommand(interaction, res) {
  const { name, options } = interaction.data
  const userId = interaction.member?.user?.id || interaction.user?.id
  const username = interaction.member?.user?.username || interaction.user?.username

  ensureUser(userId, username)

  try {
    switch (name) {
      case "ping":
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "🏓 Pong! Bot is working!" },
        })

      case "enterbetting":
        if (users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You are already registered for the betting system!" },
          })
        }

        users[userId].isRegistered = true
        users[userId].points = 1000

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "🎉 Welcome to the betting system! You've been registered and received 1000 starting points!",
          },
        })

      case "points":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        let pointsMessage = `💰 You currently have **${users[userId].points}** points!`

        if (canClaimDaily(userId)) {
          pointsMessage += "\n🎁 You can claim your daily +100 points bonus!"
        }

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: pointsMessage },
        })

      case "daily":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        if (!canClaimDaily(userId)) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You already claimed your daily points! Come back tomorrow." },
          })
        }

        users[userId].points += 100
        users[userId].lastDailyClaim = new Date().toISOString()

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "🎁 You claimed your daily +100 points! Come back tomorrow for more." },
        })

      case "pool":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        return res.json({
          type: InteractionResponseType.MODAL,
          data: {
            title: "Create Betting Pool",
            custom_id: "create_pool_modal",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "topic",
                    label: "Betting Topic",
                    style: 1,
                    placeholder: "What are people betting on?",
                    required: true,
                    max_length: 100,
                  },
                ],
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "options",
                    label: "Betting Options (comma separated)",
                    style: 2,
                    placeholder: "Option 1, Option 2, Option 3...",
                    required: true,
                    max_length: 500,
                  },
                ],
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "duration",
                    label: "Duration (minutes)",
                    style: 1,
                    placeholder: "30",
                    required: true,
                    max_length: 4,
                  },
                ],
              },
            ],
          },
        })

      case "resolvepool":
        const poolId = options?.[0]?.value
        const winningOption = parseInt(options?.[1]?.value) // Fixed: ensure it's a number

        if (!bettingPools[poolId]) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Pool not found!" },
          })
        }

        if (bettingPools[poolId].resolved) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Pool already resolved!" },
          })
        }

        const pool = bettingPools[poolId]
        const winningBets = pool.bets.filter((bet) => bet.optionIndex === winningOption)
        const totalWinningAmount = winningBets.reduce((sum, bet) => sum + bet.amount, 0)
        const totalPool = pool.bets.reduce((sum, bet) => sum + bet.amount, 0)

        // Distribute winnings
        if (totalWinningAmount > 0) {
          winningBets.forEach((bet) => {
            const winnings = Math.floor((bet.amount / totalWinningAmount) * totalPool)
            users[bet.userId].points += winnings
          })
        }

        pool.resolved = true
        pool.winningOption = winningOption
        pool.resolvedBy = userId
        pool.resolvedAt = new Date().toISOString()

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: `🏆 **Pool Resolved!**\nWinning option: **${pool.options[winningOption]}**\n${winningBets.length} winners shared ${totalPool} points!`,
          },
        })

      case "betlog":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        const userBets = users[userId].bets.slice(-10) // Last 10 bets
        if (userBets.length === 0) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You haven't placed any bets yet!" },
          })
        }

        let logText = "📊 **Your Recent Bets:**\n\n"
        userBets.forEach((bet) => {
          const pool = bettingPools[bet.poolId]
          if (pool) {
            const status = pool.resolved ? (pool.winningOption === bet.optionIndex ? "✅ Won" : "❌ Lost") : "⏳ Pending"
            logText += `**${pool.topic}**\nBet: ${bet.amount} on "${pool.options[bet.optionIndex]}" - ${status}\n\n`
          }
        })

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: logText },
        })

      case "lend":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        return res.json({
          type: InteractionResponseType.MODAL,
          data: {
            title: "Lend Points",
            custom_id: "lend_modal",
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "borrower_id",
                    label: "Borrower User ID",
                    style: 1,
                    placeholder: "Enter the user ID of the borrower",
                    required: true,
                  },
                ],
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "amount",
                    label: "Loan Amount",
                    style: 1,
                    placeholder: "How many points to lend?",
                    required: true,
                  },
                ],
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "interest_rate",
                    label: "Interest Rate (%)",
                    style: 1,
                    placeholder: "Interest rate percentage",
                    required: true,
                  },
                ],
              },
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "duration_hours",
                    label: "Duration (hours)",
                    style: 1,
                    placeholder: "Loan duration in hours",
                    required: true,
                  },
                ],
              },
            ],
          },
        })

      case "cashin":
        if (!users[userId].isRegistered) {
          return res.json({
            type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "You need to register first using `/enterbetting`!" },
          })
        }

        let shopText = "🛒 **Shop Items:**\n\n"
        Object.values(shopItems).forEach((item) => {
          shopText += `**${item.name}** - ${item.price} points\n${item.description}\n\n`
        })

        const shopButtons = Object.values(shopItems).map((item) => ({
          type: 2,
          style: 1,
          label: `${item.name} (${item.price}pts)`,
          custom_id: `shop_${item.id}`,
        }))

        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: shopText,
            components: [
              {
                type: 1,
                components: shopButtons.slice(0, 5), // Max 5 buttons per row
              },
            ],
          },
        })

      default:
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Unknown command!" },
        })
    }
  } catch (error) {
    console.error("Error in handleSlashCommand:", error)
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "An error occurred while processing your command." },
    })
  }
}

function handleButtonClick(interaction, res) {
  const { custom_id } = interaction.data
  const userId = interaction.member?.user?.id || interaction.user?.id

  try {
    if (custom_id.startsWith("bet_option_")) {
      const [, , poolId, optionIndex] = custom_id.split("_")

      return res.json({
        type: InteractionResponseType.MODAL,
        data: {
          title: "Place Your Bet",
          custom_id: `bet_amount_${poolId}_${optionIndex}`,
          components: [
            {
              type: 1,
              components: [
                {
                  type: 4,
                  custom_id: "bet_amount",
                  label: 'Bet Amount (or "all" for all-in)',
                  style: 1,
                  placeholder: "Enter amount...",
                  required: true,
                },
              ],
            },
          ],
        },
      })
    }

    if (custom_id.startsWith("shop_")) {
      const itemId = parseInt(custom_id.split("_")[1])
      const item = shopItems[itemId]

      if (!item) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Item not found!" },
        })
      }

      if (users[userId].points < item.price) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `You don't have enough points! You need ${item.price} points.` },
        })
      }

      if (item.requiresTarget) {
        return res.json({
          type: InteractionResponseType.MODAL,
          data: {
            title: `Purchase ${item.name}`,
            custom_id: `purchase_${itemId}`,
            components: [
              {
                type: 1,
                components: [
                  {
                    type: 4,
                    custom_id: "target_user_id",
                    label: "Target User ID",
                    style: 1,
                    placeholder: "Who should receive this item's effect?",
                    required: true,
                  },
                ],
              },
            ],
          },
        })
      } else {
        // Direct purchase
        users[userId].points -= item.price
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `✅ You purchased **${item.name}** for ${item.price} points!` },
        })
      }
    }

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unknown button interaction!" },
    })
  } catch (error) {
    console.error("Error in handleButtonClick:", error)
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "An error occurred while processing your button click." },
    })
  }
}

function handleModalSubmit(interaction, res) {
  const { custom_id, components } = interaction.data
  const userId = interaction.member?.user?.id || interaction.user?.id

  try {
    if (custom_id === "create_pool_modal") {
      const topic = components[0].components[0].value
      const optionsText = components[1].components[0].value
      const duration = parseInt(components[2].components[0].value)

      const options = optionsText.split(",").map((opt) => opt.trim()).filter(opt => opt.length > 0)

      if (options.length < 2) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "You need at least 2 betting options!" },
        })
      }

      const poolId = poolIdCounter++
      const expiresAt = new Date(Date.now() + duration * 60 * 1000)

      bettingPools[poolId] = {
        id: poolId,
        creatorId: userId,
        topic,
        options,
        duration,
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        resolved: false,
        bets: [],
      }

      const buttons = options.map((option, index) => ({
        type: 2,
        style: 1,
        label: option.substring(0, 80), // Discord button label limit
        custom_id: `bet_option_${poolId}_${index}`,
      }))

      const rows = []
      for (let i = 0; i < buttons.length; i += 5) {
        rows.push({
          type: 1,
          components: buttons.slice(i, i + 5),
        })
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🎲 **Betting Pool Created!**\n**Topic:** ${topic}\n**Duration:** ${duration} minutes\n**Pool ID:** ${poolId}\n\nClick a button to place your bet:`,
          components: rows,
        },
      })
    }

    if (custom_id.startsWith("bet_amount_")) {
      const [, , poolId, optionIndex] = custom_id.split("_")
      const betAmountText = components[0].components[0].value

      let betAmount
      if (betAmountText.toLowerCase() === "all") {
        betAmount = users[userId].points
      } else {
        betAmount = parseInt(betAmountText)
      }

      if (isNaN(betAmount) || betAmount <= 0) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Invalid bet amount!" },
        })
      }

      if (betAmount > users[userId].points) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "You don't have enough points!" },
        })
      }

      const pool = bettingPools[poolId]
      if (!pool) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Pool not found!" },
        })
      }

      if (pool.resolved) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "This pool has already been resolved!" },
        })
      }

      // Check if pool has expired
      if (new Date() > new Date(pool.expiresAt)) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "This betting pool has expired!" },
        })
      }

      // Place the bet
      users[userId].points -= betAmount
      const bet = {
        userId,
        poolId: parseInt(poolId),
        optionIndex: parseInt(optionIndex),
        amount: betAmount,
        placedAt: new Date().toISOString(),
      }

      pool.bets.push(bet)
      users[userId].bets.push(bet)

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ Bet placed! You bet **${betAmount}** points on "${pool.options[optionIndex]}"`,
        },
      })
    }

    if (custom_id === "lend_modal") {
      const borrowerId = components[0].components[0].value
      const amount = parseInt(components[1].components[0].value)
      const interestRate = parseFloat(components[2].components[0].value)
      const durationHours = parseInt(components[3].components[0].value)

      if (isNaN(amount) || amount <= 0) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Invalid loan amount!" },
        })
      }

      if (isNaN(interestRate) || interestRate < 0) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Invalid interest rate!" },
        })
      }

      if (interestRate > systemSettings.maxInterestRate) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `Interest rate cannot exceed ${systemSettings.maxInterestRate}%!` },
        })
      }

      if (amount > users[userId].points) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "You don't have enough points to lend!" },
        })
      }

      ensureUser(borrowerId, "Unknown User")

      const loanId = loanIdCounter++
      const dueAt = new Date(Date.now() + durationHours * 60 * 60 * 1000)

      loans[loanId] = {
        id: loanId,
        lenderId: userId,
        borrowerId,
        amount,
        interestRate,
        durationHours,
        createdAt: new Date().toISOString(),
        dueAt: dueAt.toISOString(),
        repaid: false,
      }

      users[userId].points -= amount
      users[borrowerId].points += amount

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `💰 Loan created! You lent **${amount}** points to <@${borrowerId}> at ${interestRate}% interest for ${durationHours} hours.`,
        },
      })
    }

    if (custom_id.startsWith("purchase_")) {
      const itemId = parseInt(custom_id.split("_")[1])
      const targetUserId = components[0].components[0].value
      const item = shopItems[itemId]

      if (!item) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Item not found!" },
        })
      }

      if (users[userId].points < item.price) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "You don't have enough points!" },
        })
      }

      ensureUser(targetUserId, "Unknown User")

      users[userId].points -= item.price

      // Apply item effects
      if (item.name === "Point Boost") {
        users[targetUserId].points += 200
      } else if (item.name === "Debt Forgiveness") {
        // Find and forgive loans for this user (you might want to implement this)
        // For now, just acknowledge the purchase
      }

      return res.json({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `✅ You purchased **${item.name}** for ${item.price} points and applied it to <@${targetUserId}>!`,
        },
      })
    }

    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "Unknown modal submission!" },
    })
  } catch (error) {
    console.error("Error in handleModalSubmit:", error)
    return res.json({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: "An error occurred while processing your submission." },
    })
  }
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err)
  res.status(500).json({ error: "Internal server error" })
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully')
  process.exit(0)
})

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully')
  process.exit(0)
})

// Start the server
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Discord bot server is running on port ${PORT}`)
  console.log(`📡 Health check available at: http://localhost:${PORT}/`)
  console.log(`🤖 Discord webhook endpoint: http://localhost:${PORT}/api/discord`)
})

// Handle server errors
server.on('error', (err) => {
  console.error('Server error:', err)
})

// For Railway deployment
module.exports = app

