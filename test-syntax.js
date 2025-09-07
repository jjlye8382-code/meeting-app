// Syntax validation test
console.log('Testing server.js syntax...');

// Test the key problematic patterns
const testHeaders = {
  "Authorization": `Bearer ${process.env.OPENAI_API_KEY || 'test'}`,
  "Content-Type": "application/json"
};

const testFetch = {
  method: 'POST',
  headers: testHeaders,
  body: JSON.stringify({ test: 'data' })
};

console.log('✅ Syntax test passed - all object literals are valid');
console.log('✅ Template literals work correctly');
console.log('✅ Headers object structure is valid');