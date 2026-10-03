import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
// Local-only adapter. The cloud bundle imports only the portable aircraft-data module.
export async function windowsAircraftProfile(url) {
  if (process.platform !== 'win32') return '';
  if (!/^https:\/\/airport-data\.com\/aircraft\/[A-Z0-9%-]+$/i.test(url)) return '';
  const command = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Invoke-WebRequest -UseBasicParsing -Uri $env:TRIP_AIRCRAFT_PROFILE_URL -TimeoutSec 6).Content";
  const result = await execFileAsync('powershell.exe', ['-NoLogo','-NoProfile','-NonInteractive','-Command',command], {env:{...process.env,TRIP_AIRCRAFT_PROFILE_URL:url},timeout:7500,windowsHide:true,maxBuffer:2_100_000});
  return result.stdout;
}
