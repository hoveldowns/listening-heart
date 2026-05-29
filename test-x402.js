// Test x402 payment flow programmatically
// Usage: PRIVATE_KEY=0x... node test-x402.js
//
// The agent wallet must hold USDC on Base mainnet (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)
// Bridge or buy USDC on Base via Coinbase, Uniswap, or bridge from mainnet

require('dotenv').config();
const { privateKeyToAccount } = require('viem/accounts');
const { randomBytes } = require('crypto');

// Inline implementation of createEIP3009Payload (avoids ethers transitive dep)
async function createEIP3009Payload(account, x402Version, requirements) {
  const nonce = '0x' + randomBytes(32).toString('hex');
  const now = Math.floor(Date.now() / 1000);
  const chainId = parseInt(requirements.network.split(':')[1]);

  const authorization = {
    from: account.address,
    to: requirements.payTo,
    value: requirements.amount,
    validAfter: String(now - 600),
    validBefore: String(now + requirements.maxTimeoutSeconds),
    nonce
  };

  const domain = {
    name: requirements.extra.name,
    version: requirements.extra.version,
    chainId,
    verifyingContract: requirements.asset
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from',        type: 'address' },
      { name: 'to',          type: 'address' },
      { name: 'value',       type: 'uint256' },
      { name: 'validAfter',  type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce',       type: 'bytes32' }
    ]
  };
  const message = {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce
  };

  const signature = await account.signTypedData({ domain, types, primaryType: 'TransferWithAuthorization', message });
  return { x402Version, payload: { authorization, signature } };
}

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('PRIVATE_KEY env var required');
  process.exit(1);
}

const TASK_ID = '0x9cc8c3a71429d014c3e73c6304f6ca98d2679d2c7f51afff5c3caa7394fd59ea';
const URL = `https://listening-heart.onrender.com/tasks/${TASK_ID}/notes`;

async function main() {
  const account = privateKeyToAccount(PRIVATE_KEY);
  console.log('Wallet:', account.address);

  // Step 1: Initial request — expect 402
  console.log('\n[1] POST without payment...');
  const res1 = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-wallet-address': account.address },
    body: JSON.stringify({ content: 'test from script', noteType: 'general' })
  });

  if (res1.status !== 402) {
    const body = await res1.text();
    console.log(`Unexpected status ${res1.status}:`, body);
    process.exit(1);
  }
  console.log('Got 402 as expected');

  // Step 2: Parse payment requirements from header
  const headerVal = res1.headers.get('payment-required');
  if (!headerVal) { console.error('No payment-required header'); process.exit(1); }

  const paymentRequired = JSON.parse(Buffer.from(headerVal, 'base64').toString());
  const requirements = paymentRequired.accepts[0];
  const resource = paymentRequired.resource;
  console.log('\n[2] Payment requirements:');
  console.log('  network:', requirements.network);
  console.log('  amount:', requirements.amount, '(USDC atomic units)');
  console.log('  payTo:', requirements.payTo);
  console.log('  asset:', requirements.asset);

  // Step 3: Sign the payment
  console.log('\n[3] Signing EIP-3009 authorization...');
  const x402Version = paymentRequired.x402Version;
  const paymentPayload = await createEIP3009Payload(account, x402Version, requirements);
  console.log('  from:', paymentPayload.payload.authorization.from);
  console.log('  signature:', paymentPayload.payload.signature.slice(0, 20) + '...');

  // Step 4: Build full payment object and encode
  const fullPayment = {
    ...paymentPayload,
    accepted: requirements,
    resource
  };
  const paymentHeader = Buffer.from(JSON.stringify(fullPayment)).toString('base64');
  console.log('\nFull payment object:');
  console.log(JSON.stringify(fullPayment, null, 2));

  // Step 5: Debug verify before submitting
  console.log('\n[4] Verifying with /debug/verify...');
  const verifyRes = await fetch('https://listening-heart.onrender.com/debug/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentPayload: fullPayment, paymentRequirements: requirements })
  });
  const verifyData = await verifyRes.json();
  console.log('Facilitator response:', JSON.stringify(verifyData));

  if (!verifyData.data?.isValid) {
    console.error('\nPayment invalid — not submitting. Reason:', verifyData.data?.invalidReason);
    process.exit(1);
  }

  // Step 6: Retry with payment
  console.log('\n[5] Retrying POST with payment...');
  const res2 = await fetch(URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-wallet-address': account.address,
      'payment-signature': paymentHeader
    },
    body: JSON.stringify({ content: 'test from script', noteType: 'general' })
  });

  const body2 = await res2.json();
  if (res2.ok) {
    console.log('\nSuccess! Note posted:');
    console.log(JSON.stringify(body2, null, 2));
  } else {
    console.error(`\nFailed (${res2.status}):`, JSON.stringify(body2));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
