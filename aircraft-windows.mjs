import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
// Local-only adapter. The cloud bundle imports only the portable aircraft-data module.
export async function windowsAircraftProfile(url) {
  if (process.platform !== 'win32') return '';
  if (!/^https:\/\/airport-data\.com\/aircraft\/[A-Z0-9%-]+$/i.test(url)) return '';
  const command = "$ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Invoke-WebRequest -UseBasicParsing -Uri $env:TRIP_AIRCRAFT_PROFILE_URL -TimeoutSec 20).Content";
  const args=['-NoLogo','-NoProfile','-NonInteractive','-Command',command];
  const options={env:{...process.env,TRIP_AIRCRAFT_PROFILE_URL:url},timeout:24000,windowsHide:true,maxBuffer:2_100_000};
  const bundledShell=path.resolve(path.dirname(process.execPath),'../../native/powershell/pwsh.exe');
  const shell=existsSync(bundledShell)?bundledShell:'pwsh.exe';
  try { return (await execFileAsync(shell,args,options)).stdout; }
  catch(error) {
    if(error.code!=='ENOENT')throw error;
    return (await execFileAsync('powershell.exe',args,options)).stdout;
  }
}
