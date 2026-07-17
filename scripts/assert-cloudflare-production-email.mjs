import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

export function assertProductionAuthEmailConfig(config) {
  const mode = config?.vars?.AUTH_EMAIL_DELIVERY_MODE;
  if (mode !== 'email') {
    throw new Error('production_auth_email_delivery_mode_must_be_email');
  }

  const fromAddress = config?.vars?.AUTH_EMAIL_FROM;
  if (typeof fromAddress !== 'string' || fromAddress.trim().length === 0) {
    throw new Error('production_auth_email_from_required');
  }

  const authEmailBinding = Array.isArray(config?.send_email)
    ? config.send_email.find((binding) => binding?.name === 'AUTH_EMAIL')
    : undefined;
  if (!authEmailBinding) {
    throw new Error('production_auth_email_binding_required');
  }

  const allowedSenders = authEmailBinding.allowed_sender_addresses;
  const normalizedFromAddress = fromAddress.trim().toLowerCase();
  if (
    !Array.isArray(allowedSenders) ||
    !allowedSenders.some(
      (allowedSender) =>
        typeof allowedSender === 'string' &&
        allowedSender.trim().toLowerCase() === normalizedFromAddress,
    )
  ) {
    throw new Error('production_auth_email_sender_restriction_required');
  }
}

export async function checkProductionAuthEmailConfig(configPath = 'wrangler.jsonc') {
  const resolvedPath = resolve(configPath);
  const source = await readFile(resolvedPath, 'utf8');
  const parsed = ts.parseConfigFileTextToJson(resolvedPath, source);
  if (parsed.error || !parsed.config) {
    throw new Error('production_wrangler_config_invalid');
  }
  assertProductionAuthEmailConfig(parsed.config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await checkProductionAuthEmailConfig(process.argv[2]);
}
