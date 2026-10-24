import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skillPackage = path.join(root, 'alexa-skill-package');
const envFile = process.env.ALEXA_TEMPLATE_ENV_FILE || path.join(skillPackage, 'alexa.env');
const checkOnly = process.argv.includes('--check');

function readEnvFile(filename) {
  if (!existsSync(filename)) return {};

  const values = {};
  for (const line of readFileSync(filename, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    values[match[1]] = value;
  }
  return values;
}

const fileValues = readEnvFile(envFile);
const values = { ...fileValues, ...process.env };

function required(name) {
  const value = String(values[name] || '').trim();
  if (!value) {
    throw new Error(`Missing ${name}. Copy alexa-skill-package/alexa.env.example to alexa-skill-package/alexa.env and set it.`);
  }
  return value;
}

const endpoint = required('ALEXA_ENDPOINT_URL');
const skillName = required('ALEXA_SKILL_NAME');
const invocationName = required('ALEXA_INVOCATION_NAME');

let parsedEndpoint;
try {
  parsedEndpoint = new URL(endpoint);
} catch {
  throw new Error('ALEXA_ENDPOINT_URL must be a valid HTTPS URL.');
}

if (
  parsedEndpoint.protocol !== 'https:'
  || parsedEndpoint.username
  || parsedEndpoint.password
  || parsedEndpoint.search
  || parsedEndpoint.hash
) {
  throw new Error('ALEXA_ENDPOINT_URL must use HTTPS and contain no credentials, query, or fragment.');
}

if (skillName.length > 50) throw new Error('ALEXA_SKILL_NAME must be 50 characters or fewer.');
const invocationWords = invocationName.split(' ');
const forbiddenInvocationWords = new Set([
  'alexa',
  'amazon',
  'echo',
  'computer',
  'skill',
  'app',
  'application',
  'start',
  'play',
  'resume',
  'use',
  'launch',
  'ask',
  'open',
  'tell',
  'load',
  'begin',
  'activate',
  'to',
  'from',
  'by',
  'if',
  'and',
  'whether',
]);
const invocationToken = String.raw`(?:[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)?|[\p{L}\p{M}]\.)`;
const invocationNamePattern = new RegExp(`^${invocationToken}(?: ${invocationToken})+$`, 'u');

if (invocationName.length > 50 || invocationWords.length < 2) {
  throw new Error('ALEXA_INVOCATION_NAME must contain at least two words and be 50 characters or fewer.');
}
if (invocationName !== invocationName.toLocaleLowerCase('en-US')) {
  throw new Error('ALEXA_INVOCATION_NAME must use lowercase letters.');
}
if (!invocationNamePattern.test(invocationName)) {
  throw new Error('ALEXA_INVOCATION_NAME may contain only lowercase letters, spaces, and apostrophes within words.');
}
const forbiddenInvocationWord = invocationWords.find((word) => forbiddenInvocationWords.has(word));
if (forbiddenInvocationWord) {
  throw new Error(`ALEXA_INVOCATION_NAME cannot contain "${forbiddenInvocationWord}" or a launch phrase.`);
}

const replacementValues = {
  __ALEXA_ENDPOINT_URL__: endpoint,
  __ALEXA_SKILL_NAME__: skillName,
  __ALEXA_INVOCATION_NAME__: invocationName,
  __ALEXA_DESCRIPTION__: String(values.ALEXA_DESCRIPTION || `A voice skill for ${skillName}.`).trim(),
  __ALEXA_SUMMARY__: String(values.ALEXA_SUMMARY || `Control ${skillName} with Alexa.`).trim(),
  __ALEXA_TESTING_INSTRUCTIONS__: String(
    values.ALEXA_TESTING_INSTRUCTIONS
      || 'Use the configured invocation name to test the development skill.',
  ).trim(),
};
const replacements = Object.fromEntries(
  Object.entries(replacementValues).map(([token, value]) => [
    token,
    JSON.stringify(String(value)).slice(1, -1),
  ]),
);

const files = [
  ['skill.json.template', 'skill.json'],
  ['interactionModels/custom/en-US.json.template', 'interactionModels/custom/en-US.json'],
  ['interactionModels/custom/en-IN.json.template', 'interactionModels/custom/en-IN.json'],
  ['interactionModels/custom/hi-IN.json.template', 'interactionModels/custom/hi-IN.json'],
];

function render(template, filename) {
  let rendered = template;
  for (const [token, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, value);
  }
  if (rendered.includes('__ALEXA_')) {
    throw new Error(`Unresolved Alexa template token in ${filename}.`);
  }
  try {
    return `${JSON.stringify(JSON.parse(rendered), null, 2)}\n`;
  } catch (error) {
    throw new Error(`Invalid generated JSON for ${filename}: ${error.message}`);
  }
}

for (const [templateName, outputName] of files) {
  const templatePath = path.join(skillPackage, templateName);
  const outputPath = path.join(skillPackage, outputName);
  const rendered = render(readFileSync(templatePath, 'utf8'), templateName);
  if (!checkOnly) {
    await mkdir(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, rendered);
  }
}

console.log(checkOnly
  ? 'Alexa skill templates are valid for the supplied configuration.'
  : 'Generated the Alexa skill package from local deployment configuration.');
