const { EmbedBuilder } = require('discord.js');

// Format numbers with commas
function formatNumber(number) {
  return number.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Format dates in a user-friendly way
function formatDate(date) {
  const d = new Date(date);
  const now = new Date();
  const diffTime = Math.abs(now - d);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 1) {
    return d.toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit',
      hour12: true 
    }) + ' (Today)';
  } else if (diffDays <= 7) {
    return d.toLocaleDateString('en-US', { 
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  } else {
    return d.toLocaleDateString('en-US', { 
      month: 'short', 
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
}

// Create a standard embed
function createEmbed(title, description, color = 0x3498db) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
}

// Create a success embed
function createSuccessEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(`✅ ${title}`)
    .setDescription(description)
    .setColor(0x2ecc71)
    .setTimestamp();
}

// Create an error embed
function createErrorEmbed(title, description = null) {
  const embed = new EmbedBuilder()
    .setTitle(`❌ ${title}`)
    .setColor(0xe74c3c)
    .setTimestamp();
    
  if (description) {
    embed.setDescription(description);
  }
  
  return embed;
}

// Create a warning embed
function createWarningEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(`⚠️ ${title}`)
    .setDescription(description)
    .setColor(0xf39c12)
    .setTimestamp();
}

// Create an info embed
function createInfoEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(`ℹ️ ${title}`)
    .setDescription(description)
    .setColor(0x3498db)
    .setTimestamp();
}

// Calculate interest
function calculateInterest(principal, rate, days) {
  return Math.floor(principal * rate * (days / 30));
}

// Calculate betting odds
function calculateOdds(totalPool, optionPool) {
  if (optionPool === 0) return 0;
  return totalPool / optionPool;
}

// Generate a random color
function getRandomColor() {
  const colors = [0x3498db, 0x2ecc71, 0xe74c3c, 0xf39c12, 0x9b59b6, 0x1abc9c, 0x34495e];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Truncate text to a specific length
function truncateText(text, maxLength = 100) {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

// Create a progress bar
function createProgressBar(current, max, length = 10) {
  const percentage = Math.min(current / max, 1);
  const filled = Math.round(length * percentage);
  const empty = length - filled;
  
  return '█'.repeat(filled) + '░'.repeat(empty);
}

module.exports = {
  formatNumber,
  formatDate,
  createEmbed,
  createSuccessEmbed,
  createErrorEmbed,
  createWarningEmbed,
  createInfoEmbed,
  calculateInterest,
  calculateOdds,
  getRandomColor,
  truncateText,
  createProgressBar
};