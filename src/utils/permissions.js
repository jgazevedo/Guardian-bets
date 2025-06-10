// Admin user IDs - Add your Discord user ID here
const adminUserIds = [
  "121564489043804161", // Replace with actual admin user IDs
  // Add more admin IDs as needed
];

function isAdmin(userId) {
  return adminUserIds.includes(userId);
}

function isModerator(userId) {
  // Add moderator logic here if needed
  return isAdmin(userId);
}

module.exports = {
  isAdmin,
  isModerator,
  adminUserIds
};