import { Simulator } from './commonTypes';
import { _execFile } from './utils';
import * as logger from './logger';
import * as fs from 'fs';
import { spawn } from 'child_process';

export async function listSimulators(): Promise<Simulator[]>
{
    return _execFile('xcrun', ['simctl', 'list', '--json'])
        .then(({stdout, stderr}): Simulator[] => {
            if (stderr) { logger.error(stderr); }

            let simctlList = JSON.parse(stdout) || {};
            let runtimes: {[key: string]: any} = {};
            let devices: Simulator[] = [];
            
            // Add all available runtimes
            for (const runtime of simctlList.runtimes) {
                if (runtime.isAvailable) {
                    runtimes[runtime.identifier] = runtime;
                }
            }

            // Add all available devices
            for (const runtimeIdentifier of Object.keys(simctlList.devices)) {
                // We're only interested in iOS simulators
                if (!runtimeIdentifier.startsWith("com.apple.CoreSimulator.SimRuntime.iOS")) {
                    continue;
                }

                // In some cases when you have a booted simulator with an unavailable runtime,
                // the device shows up as available. The runtime properties are not available at this time.
                // So, use this fallback.
                const runtimeFallback = runtimeIdentifier.replace("com.apple.CoreSimulator.SimRuntime.", "");

                devices.push(
                    ...
                    simctlList.devices[runtimeIdentifier]
                        .filter((d: any) => d.isAvailable)
                        .map(({udid, name, dataPath, logPath, state}: Simulator): Simulator => ({
                            udid,
                            name,
                            type: "Simulator",
                            version: runtimes[runtimeIdentifier]?.version || runtimeFallback.replace(/(.*?)-(.*)/, "$2").replace("-", "."),
                            buildVersion: runtimes[runtimeIdentifier]?.buildversion || runtimeFallback,
                            runtime: runtimes[runtimeIdentifier]?.name || runtimeFallback.replace(/(.*?)-(.*)/, "$1 $2").replace("-", "."),
                            sdk: "iphonesimulator",
                            dataPath,
                            logPath,
                            state,
                        }))
                );
            }

            devices = devices
                        .sort((a: Simulator, b: Simulator) => (
                            b.runtime.localeCompare(a.runtime, undefined, {numeric: true})
                                || a.name.localeCompare(b.name, undefined, {numeric: true})
                        ));

            logger.log(`Found ${devices.length} simulators`);

            return devices;
        }).catch(e => {
            logger.log(e);
            return [];
        });
}

export async function isValid(simulator: Simulator): Promise<boolean>
{
    return _execFile('xcrun', ['simctl', 'list', 'devices', '--json'])
        .then(({stdout, stderr}): boolean => {
            if (stderr) { logger.error(stderr); }

            let simctlList = JSON.parse(stdout) || {};
            let devices: Simulator[] = [];

            // Add all available devices
            for (const runtimeIdentifier of Object.keys(simctlList.devices)) {
                devices.push(
                    ...
                    simctlList.devices[runtimeIdentifier]
                        .filter((d: any) => d.isAvailable)
                );
            }

            devices = devices.filter((d: Simulator) => d.udid === simulator.udid);

            return !!devices.length;
        }).catch(e => {
            logger.error(e);
            return false;
        });
}

export async function boot(udid: string): Promise<void>
{
    logger.log(`Booting simulator (udid: ${udid}) if required`);
    let time = new Date().getTime();
    await _execFile('xcrun', ['simctl', 'bootstatus', udid, '-b']);
    logger.log(`Booted in ${new Date().getTime() - time} ms`);
}

export async function install(udid: string, path: string): Promise<void>
{
    logger.log(`Installing app (path: ${path}) to simulator (udid: ${udid})`);
    let time = new Date().getTime();

    await _execFile('xcrun', ['simctl', 'install', udid, path]);

    logger.log(`Installed in ${new Date().getTime() - time} ms`);
}

export async function launch(udid: string, bundleId: string, args: string[], env: {[key: string]: string}, stdio: {stdout: string, stderr: string}, waitForDebugger: boolean = false): Promise<Number>
{
    logger.log(`Launching app (id: ${bundleId}) on simulator (udid: ${udid})`);
    let time = new Date().getTime();

    args = args ?? [];
    env = env ?? {};

    let simctlEnv: {[key: string]: string} = {};

    Object.keys(env).forEach((key) => {
        simctlEnv[`SIMCTL_CHILD_${key}`] = env[key];
    });

    let process = spawn(
        'xcrun',
        [
            'simctl', 
            'launch', 
            ...(waitForDebugger ? ['--wait-for-debugger'] : []),
            '--terminate-running-process',
            '--console-pty',
            udid,
            bundleId,
            ...args
        ],
        {
            env: simctlEnv
        }
    );
    process.stdout.pipe(fs.createWriteStream(stdio.stdout));
    process.stderr.pipe(fs.createWriteStream(stdio.stderr));

    // simctl doesn't print the pid until the process terminates (output is buffered), so instead
    // get the pid once the app is launched.
    let start = new Date().getTime();
    while (new Date().getTime() - start < 10_000) {
        try {
            let pid = await getPidFor(udid, bundleId);
            logger.log(`Launched in ${new Date().getTime() - time} ms`);
            return pid;
        } catch (error) {
            logger.log(`Waiting for app to launch`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    logger.log(`Launch failed in ${new Date().getTime() - time} ms`);
    throw new Error("Could not launch and get pid");
}

export async function getPidFor(udid: string, appBundleId: string): Promise<Number>
{
    logger.log(`Getting pid (appBundleId: ${appBundleId}) for simulator (udid: ${udid})`);
    let time = new Date().getTime();

    // simctl spawn booted launchctl list
    let {stdout, stderr} = await _execFile('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);

    let match = stdout.match(new RegExp(`^(\\d+).+?UIKitApplication:${appBundleId}.*$`, 'm'));
    if (!match) {
        throw new Error(`Could not find pid for ${appBundleId}`);
    }
    
    logger.log(`Got pid in ${new Date().getTime() - time} ms`);
    return parseInt(match[1]);
}
