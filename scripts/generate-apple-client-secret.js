#!/usr/bin/env node
/**
 * Generate Apple Sign In Client Secret (JWT)
 *
 * Apple requires a JWT signed with your private key as the client secret.
 * This JWT is valid for up to 6 months.
 *
 * Usage:
 *   node generate-apple-client-secret.js <team_id> <services_id> <key_id> <path_to_p8_file>
 *
 * Example:
 *   node generate-apple-client-secret.js 7RS696YC75 com.kreativekoala.listenai.auth XXXXXXXXXX ./AuthKey_XXXXXXXXXX.p8
 */

const crypto = require('crypto');
const fs = require('fs');

function generateAppleClientSecret(teamId, servicesId, keyId, privateKeyPath) {
    // Read the private key
    const privateKey = fs.readFileSync(privateKeyPath, 'utf8');

    // JWT Header
    const header = {
        alg: 'ES256',
        kid: keyId,
        typ: 'JWT'
    };

    // JWT Payload
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iss: teamId,
        iat: now,
        exp: now + (86400 * 180), // 180 days (max allowed)
        aud: 'https://appleid.apple.com',
        sub: servicesId
    };

    // Base64URL encode
    function base64url(data) {
        return Buffer.from(JSON.stringify(data))
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    }

    // Create signature
    const headerB64 = base64url(header);
    const payloadB64 = base64url(payload);
    const signatureInput = `${headerB64}.${payloadB64}`;

    const sign = crypto.createSign('SHA256');
    sign.update(signatureInput);
    sign.end();

    const signature = sign.sign(privateKey, 'base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

    return `${signatureInput}.${signature}`;
}

// Parse command line arguments
const args = process.argv.slice(2);

if (args.length !== 4) {
    console.log(`
Apple Sign In Client Secret Generator
=====================================

Usage:
  node generate-apple-client-secret.js <team_id> <services_id> <key_id> <path_to_p8_file>

Arguments:
  team_id       - Your Apple Developer Team ID (e.g., 7RS696YC75)
  services_id   - Your Services ID created for Sign in with Apple (e.g., com.kreativekoala.listenai.auth)
  key_id        - The Key ID from Apple Developer Portal (shown when you created the key)
  path_to_p8    - Path to the .p8 private key file you downloaded

Example:
  node generate-apple-client-secret.js 7RS696YC75 com.kreativekoala.listenai.auth ABC123DEFG ./AuthKey_ABC123DEFG.p8

The output JWT can be pasted directly into Supabase Dashboard > Authentication > Providers > Apple > Secret Key
`);
    process.exit(1);
}

const [teamId, servicesId, keyId, p8Path] = args;

// Validate p8 file exists
if (!fs.existsSync(p8Path)) {
    console.error(`Error: Private key file not found: ${p8Path}`);
    process.exit(1);
}

try {
    const clientSecret = generateAppleClientSecret(teamId, servicesId, keyId, p8Path);

    console.log('\n=== Apple Client Secret (JWT) ===\n');
    console.log(clientSecret);
    console.log('\n=================================\n');
    console.log('Copy the JWT above and paste it into:');
    console.log('Supabase Dashboard > Authentication > Providers > Apple > Secret Key');
    console.log('\nThis token is valid for 180 days. Generate a new one before it expires.');

    // Also show expiry date
    const expiryDate = new Date(Date.now() + (86400 * 180 * 1000));
    console.log(`\nExpires: ${expiryDate.toISOString().split('T')[0]}`);

} catch (error) {
    console.error('Error generating client secret:', error.message);
    process.exit(1);
}
