#!/usr/bin/env node
/**
 * Test script to verify the writable mock filesystem works end-to-end.
 *
 * Tests:
 * 1. Server API endpoints work (read/write/reset)
 * 2. Changes persist until reset
 * 3. Reset restores original data
 */

const BASE_URL = 'http://localhost:5173';

async function testReadFile(path) {
  const response = await fetch(`${BASE_URL}/__mock-fs${path}`);
  if (!response.ok) {
    throw new Error(`Failed to read ${path}: ${response.status}`);
  }
  const data = await response.json();
  return data.content;
}

async function testWriteFile(path, content) {
  const response = await fetch(`${BASE_URL}/__mock-fs${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new Error(`Failed to write ${path}: ${response.status}`);
  }
  return await response.json();
}

async function testReset() {
  const response = await fetch(`${BASE_URL}/__mock-fs-reset`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Failed to reset: ${response.status}`);
  }
  return await response.json();
}

async function testSync() {
  const response = await fetch(`${BASE_URL}/__mock-fs-sync`);
  if (!response.ok) {
    throw new Error(`Failed to sync: ${response.status}`);
  }
  return await response.json();
}

async function runTests() {
  console.log('🧪 Testing Writable Mock Filesystem\n');

  const agentcorePath = '/mock/workspace/agentcore/agentcore.json';

  // Test 1: Read original file
  console.log('1️⃣  Testing: Read original file...');
  const originalContent = await testReadFile(agentcorePath);
  const original = JSON.parse(originalContent);
  console.log(`   ✅ Original workspace name: "${original.name}"`);
  console.log(`   ✅ Original has ${original.agents?.length || 0} agents`);

  // Test 2: Write modified content
  console.log('\n2️⃣  Testing: Write modified content...');
  const modified = {
    ...original,
    name: 'ModifiedWorkspace',
    description: 'This was modified by the test script!',
    agents: original.agents?.slice(0, 1) || [], // Keep only first agent
  };
  await testWriteFile(agentcorePath, JSON.stringify(modified, null, 2));
  console.log('   ✅ Write successful');

  // Test 3: Read back modified content
  console.log('\n3️⃣  Testing: Read back modified content...');
  const readBackContent = await testReadFile(agentcorePath);
  const readBack = JSON.parse(readBackContent);
  if (readBack.name !== 'ModifiedWorkspace') {
    throw new Error(`Expected name "ModifiedWorkspace", got "${readBack.name}"`);
  }
  console.log(`   ✅ Modified workspace name: "${readBack.name}"`);
  console.log(`   ✅ Modified has ${readBack.agents?.length || 0} agents`);

  // Test 4: Verify changes persist via sync endpoint
  console.log('\n4️⃣  Testing: Verify changes via sync endpoint...');
  const syncData = await testSync();
  const syncedContent = syncData.files[agentcorePath]?.content;
  if (!syncedContent?.includes('ModifiedWorkspace')) {
    throw new Error('Sync endpoint did not return modified content');
  }
  console.log('   ✅ Changes are visible in sync endpoint');

  // Test 5: Reset filesystem
  console.log('\n5️⃣  Testing: Reset filesystem...');
  await testReset();
  console.log('   ✅ Reset successful');

  // Test 6: Verify reset restored original
  console.log('\n6️⃣  Testing: Verify reset restored original...');
  const afterResetContent = await testReadFile(agentcorePath);
  const afterReset = JSON.parse(afterResetContent);
  if (afterReset.name !== original.name) {
    throw new Error(`Expected name "${original.name}", got "${afterReset.name}"`);
  }
  console.log(`   ✅ Reset restored workspace name: "${afterReset.name}"`);
  console.log(`   ✅ Reset restored ${afterReset.agents?.length || 0} agents`);

  console.log('\n🎉 All tests passed!\n');
  console.log('The writable mock filesystem is working correctly.');
  console.log('- Changes persist in memory during the dev session');
  console.log('- Reset restores the original mock data');
  console.log('- Refreshing the page will reload data from server memory');
}

runTests().catch(err => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
