#!/usr/bin/env node
// scripts/create-user.js
// Usage: node scripts/create-user.js
// Or:    node scripts/create-user.js <username> <password> [role]

const path = require('path');
const readline = require('readline');

// Adjust path since script lives in src/scripts/
const { createUser, getAllUsers, deleteUser, updatePassword, userCount } = require(path.join(__dirname, '..', 'db'));

const args = process.argv.slice(2);
const command = args[0];

// ─── Non-interactive mode (CI / quick setup) ────────────────────────────────
if (command === 'add' && args[1] && args[2]) {
  const username = args[1];
  const password = args[2];
  const role     = args[3] || 'gm';
  const result   = createUser(username, password, role);
  if (result.success) {
    console.log(`✅ Created user "${username}" with role "${role}"`);
  } else {
    console.error(`❌ ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

if (command === 'list') {
  const users = getAllUsers();
  if (!users.length) { console.log('No users found.'); process.exit(0); }
  console.log('\nGM Accounts:');
  console.log('─'.repeat(60));
  users.forEach(u => {
    const lastLogin = u.last_login
      ? new Date(u.last_login * 1000).toLocaleString()
      : 'never';
    console.log(`  ${u.username.padEnd(20)} role: ${u.role.padEnd(8)} last login: ${lastLogin}`);
  });
  console.log('─'.repeat(60));
  process.exit(0);
}

if (command === 'delete' && args[1]) {
  const ok = deleteUser(args[1]);
  console.log(ok ? `✅ Deleted "${args[1]}"` : `❌ User "${args[1]}" not found`);
  process.exit(ok ? 0 : 1);
}

if (command === 'passwd' && args[1] && args[2]) {
  const ok = updatePassword(args[1], args[2]);
  console.log(ok ? `✅ Password updated for "${args[1]}"` : `❌ User "${args[1]}" not found`);
  process.exit(ok ? 0 : 1);
}

// ─── Interactive mode ────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(res => rl.question(q, res));

async function main() {
  console.log('\n🎵 Bards of the Realm — User Management');
  console.log('─'.repeat(40));

  const total = userCount();
  console.log(`Current GM accounts: ${total}\n`);

  console.log('Commands:');
  console.log('  1) Create user');
  console.log('  2) List all users');
  console.log('  3) Delete user');
  console.log('  4) Reset password');
  console.log('  5) Exit\n');

  const choice = (await ask('Choose [1-5]: ')).trim();

  if (choice === '1') {
    const username = (await ask('Username: ')).trim();
    if (!username) { console.log('❌ Username cannot be empty'); rl.close(); return; }
    if (!/^[a-z0-9_-]{2,32}$/.test(username.toLowerCase())) {
      console.log('❌ Username must be 2-32 characters, letters/numbers/- only');
      rl.close(); return;
    }

    const password = (await ask('Password: ')).trim();
    if (password.length < 8) { console.log('❌ Password must be at least 8 characters'); rl.close(); return; }

    const roleInput = (await ask('Role [gm/admin] (default: gm): ')).trim().toLowerCase() || 'gm';
    const role = ['gm', 'admin'].includes(roleInput) ? roleInput : 'gm';

    const result = createUser(username, password, role);
    if (result.success) {
      console.log(`\n✅ Created "${username}" with role "${role}"`);
    } else {
      console.log(`\n❌ ${result.error}`);
    }

  } else if (choice === '2') {
    const users = getAllUsers();
    if (!users.length) { console.log('No users found.'); }
    else {
      console.log('\nGM Accounts:');
      console.log('─'.repeat(60));
      users.forEach(u => {
        const lastLogin = u.last_login
          ? new Date(u.last_login * 1000).toLocaleString()
          : 'never';
        console.log(`  ${u.username.padEnd(20)} role: ${u.role.padEnd(8)} last login: ${lastLogin}`);
      });
    }

  } else if (choice === '3') {
    const username = (await ask('Username to delete: ')).trim();
    const confirm  = (await ask(`Delete "${username}"? [y/N]: `)).trim().toLowerCase();
    if (confirm === 'y') {
      const ok = deleteUser(username);
      console.log(ok ? `✅ Deleted "${username}"` : `❌ User not found`);
    } else {
      console.log('Cancelled.');
    }

  } else if (choice === '4') {
    const username    = (await ask('Username: ')).trim();
    const newPassword = (await ask('New password: ')).trim();
    if (newPassword.length < 8) { console.log('❌ Password must be at least 8 characters'); rl.close(); return; }
    const ok = updatePassword(username, newPassword);
    console.log(ok ? `✅ Password updated for "${username}"` : `❌ User not found`);

  } else {
    console.log('Bye!');
  }

  rl.close();
}

main().catch(err => { console.error(err); rl.close(); process.exit(1); });
