/**
 * Module for controlling and working with Kits.
 */
/** */

import { ConfigurationReader } from '@cmt/config';
import { StateManager } from '@cmt/state';
import * as json5 from 'json5';
import * as path from 'path';
import * as vscode from 'vscode';

import * as logging from './logging';
import paths from './paths';
import { fs } from './pr';
import * as proc from './proc';
import { loadSchema } from './schema';
import { compare, dropNulls, Ordering, thisExtensionPath } from './util';
import { MultiWatcher } from './watcher';
import { findItem } from '@cmt/util';

const log = logging.createLogger('kit');

type ProgressReporter = vscode.Progress<{message?: string}>;

/**
 * Representation of a CMake generator, along with a toolset and platform
 */
export interface CMakeGenerator {
  name: string;
  toolset?: string;
  platform?: string;
}

export interface Kit {
  /**
   * The name of the kit
   */
  name: string;

  /**
   * The path of the kit
   */
  toolchainBinaryPath: string;

  /**
   * The preferred CMake generator for this kit
   */
  preferredGenerator?: CMakeGenerator;

  /**
   * Additional settings to pass to CMake
   */
  cmakeSettings?: {[key: string]: string};

  /**
   * Additional environment variables for the kit
   */
  environmentVariables?: proc.EnvironmentVariables;

  /**
   * The language compilers.
   *
   * The key `lang` is the language, as in `CMAKE_<lang>_COMPILER`.
   * The corresponding value is a path to a compiler for that language.
   */
  compilers?: {[lang: string]: string};

  /**
   * The visual studio name. This corresponds to a name returned by `vswhere`,
   * and is used to look up the path to the VS installation when the user
   * selects this kit
   */
  visualStudio?: string;

  /**
   * The architecture for the kit. This is used when asking for the architecture
   * from the dev environment batch file.
   */
  visualStudioArchitecture?: string;

  /**
   * Path to a CMake toolchain file.
   */
  toolchainFile?: string;
}

/**
 * Convert a binary (by path) to a CompilerKit. This checks if the named binary
 * is a GCC or Clang compiler and gets its version. If it is not a compiler,
 * returns `null`.
 * @returns A CompilerKit, or null if `bin` is not a known compiler
 */
export async function kitIfCompiler(bin: string, pr?: ProgressReporter): Promise<Kit|null> {
  const fname = path.basename(bin);
  // Check by filename what the compiler might be. This is just heuristic.
  // const gcc_regex = /^((\w+-)*)gcc(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const gcc_regex = /^((\w+-)*)gcc(\.exe)?$/;
  const clang_regex = /^clang(-\d+(\.\d+(\.\d+)?)?)?(\.exe)?$/;
  const gcc_res = gcc_regex.exec(fname);
  const clang_res = clang_regex.exec(fname);
  if (gcc_res) {
    log.info('Testing GCC-ish binary:', bin);
    if (pr) {
      pr.report({ message: `Getting GCC version for ${bin}` });
    }
    const exec = await proc.execute(bin, ['-v']).result;
    if (exec.retc != 0) {
      log.warning('Bad GCC binary ("-v" returns non-zero)', bin);
      return null;
    }
    const last_line = exec.stderr.trim().split('\n').reverse()[0];
    const version_re = /^gcc version (.*?) .*/;
    const version_match = version_re.exec(last_line);
    if (version_match === null) {
      log.warning('Bad GCC binary', bin, '-v output:', exec.stderr);
      return null;
    }
    const version = version_match[1];
    const target_triple_re = /((\w+-)+)gcc.*/;
    const target_triple_match = target_triple_re.exec(fname);
    let description = '';
    if (target_triple_match !== null) {
      description += `for ${target_triple_match[1].slice(0, -1)} `;
    }
    log.info('Detected GCC compiler:', bin);
    const name = `GCC ${description}${version}`;
    const compilers: {[id: string]: string} = {
      C: bin,
    };
    return {
      toolchainBinaryPath: path.dirname(bin),
      name,
      compilers,
    };
  } else if (clang_res) {
    log.info('Testing Clang-ish binary:', bin);
    if (pr) {
      pr.report({ message: `Getting Clang version for ${bin}` });
    }
    const exec = await proc.execute(bin, ['-v']).result;
    if (exec.retc != 0) {
      log.warning('Bad Clang binary ("-v" returns non-zero)', bin);
      return null;
    }
    const first_line = exec.stderr.split('\n')[0];
    const version_re = /^(?:Apple LLVM|clang) version (.*?)[ -]/;
    const version_match = version_re.exec(first_line);
    if (version_match === null) {
      log.warning('Bad Clang binary', bin, '-v output:', exec.stderr);
      return null;
    }
    const version = version_match[1];
    const clangxx_fname = fname.replace(/^clang/, 'clang++');
    const clangxx_bin = path.join(path.dirname(bin), clangxx_fname);
    const name = `Clang ${version}`;
    log.info('Detected Clang compiler:', bin);
    if (await fs.exists(clangxx_bin)) {
      return {
        name,
        toolchainBinaryPath: path.dirname(bin),
        compilers: {
          C: bin,
          CXX: clangxx_bin,
        },
      };
    } else {
      return {
        name,
        toolchainBinaryPath: path.dirname(bin),
        compilers: {
          C: bin,
        },
      };
    }
  } else {
    log.info('filename not like a compiler:', bin);
    return null;
  }
}

/**
 * Scans a directory for compiler binaries.
 */
export async function scanDirForCompilerKits(dir: string, pr?: ProgressReporter): Promise<Kit[]> {
  if (pr) {
    pr.report({ message: `Checking ${dir} for compilers...` });
  }
  if (!await fs.exists(dir)) {
    log.info('Skipping scan of not existing path', dir);
    return [];
  }

  log.info('Scanning directory', dir, 'for compilers');
  try {
    const stat = await fs.stat(dir);

    if (!stat.isDirectory()) {
      log.warning('Skipping scan of non-directory', dir);
      return [];
    }
  } catch (e) {
    log.warning('Failed to scan', dir, 'by exception:', e);
    if (e.code == 'ENOENT') {
      return [];
    }
    throw e;
  }
  let bins: string[];
  try {
    bins = (await fs.readdir(dir)).map(f => path.join(dir, f));
  } catch (e) {
    log.warning('Failed to use binary in', dir, 'by error:', e);
    if (e.code == 'EACCESS' || e.code == 'EPERM') {
      return [];
    }
    throw e;
  }
  // Scan each binary in parallel
  const prs = bins.map(async bin => {
    log.trace('Checking file for compiler-ness:', bin);
    try {

      return await kitIfCompiler(bin, pr);
    } catch (e) {

      log.warning('Failed to check binary', bin, 'by exception:', e);
      const stat = await fs.stat(bin);
      log.warning(
        'File infos: ',
        'Mode',
        stat.mode,
        'isFile',
        stat.isFile(),
        'isDirectory',
        stat.isDirectory(),
        'isSymbolicLink',
        stat.isSymbolicLink(),
      );
      if (e.code == 'EACCES') {
        // The binary may not be executable by this user...
        return null;
      } else if (e.code == 'ENOENT') {
        // This will happen on Windows if we try to "execute" a directory
        return null;
      } else if (e.code == 'UNKNOWN' && process.platform == 'win32') {
        // This is when file is not executable (in windows)
        return null;
      }
      throw e;
    }
  });
  const kits = dropNulls(await Promise.all(prs));
  log.debug('Found', kits.length, 'kits in directory', dir);
  return kits;
}

/**
 * Description of a Visual Studio installation returned by vswhere.exe
 *
 * This isn't _all_ the properties, just the ones we need so far.
 */
export interface VSInstallation {
  instanceId: string;
  displayName?: string;
  installationPath: string;
  installationVersion: string;
  description: string;
  isPrerelease: boolean;
}

/**
 * Get a list of all Visual Studio installations available from vswhere.exe
 *
 * Will not include older versions. vswhere doesn't seem to list them?
 */
export async function vsInstallations(): Promise<VSInstallation[]> {
  const installs = [] as VSInstallation[];
  const inst_ids = [] as string[];
  const vswhere_exe = path.join(thisExtensionPath(), 'res', 'vswhere.exe');
  const sys32_path = path.join(process.env.WINDIR as string, 'System32');

  const vswhere_args =
    ['/c', `${sys32_path}\\chcp 65001 | "${vswhere_exe}" -all -format json -products * -legacy -prerelease`];
  const vswhere_res
    = await proc.execute(`${sys32_path}\\cmd.exe`, vswhere_args, null, { silent: true, encoding: 'utf8', shell: true })
    .result;

  if (vswhere_res.retc !== 0) {
    log.error('Failed to execute vswhere.exe:', vswhere_res.stderr);
    return [];
  }

  const vs_installs = JSON.parse(vswhere_res.stdout) as VSInstallation[];
  for (const inst of vs_installs) {
    if (inst_ids.indexOf(inst.instanceId) < 0) {
      installs.push(inst);
      inst_ids.push(inst.instanceId);
    }
  }
  return installs;
}

/**
 * List of environment variables required for Visual C++ to run as expected for
 * a VS installation.
 */
const MSVC_ENVIRONMENT_VARIABLES = [
  'CL',
  '_CL_',
  'INCLUDE',
  'LIBPATH',
  'LINK',
  '_LINK_',
  'LIB',
  'PATH',
  'TMP',
  'FRAMEWORKDIR',
  'FRAMEWORKDIR64',
  'FRAMEWORKVERSION',
  'FRAMEWORKVERSION64',
  'UCRTCONTEXTROOT',
  'UCRTVERSION',
  'UNIVERSALCRTSDKDIR',
  'VCINSTALLDIR',
  'VCTARGETSPATH',
  'WINDOWSLIBPATH',
  'WINDOWSSDKDIR',
  'WINDOWSSDKLIBVERSION',
  'WINDOWSSDKVERSION',
  'VISUALSTUDIOVERSION',
];

/**
 * Get the environment variables corresponding to a VS dev batch file.
 * @param devbat Path to a VS environment batch file
 * @param args List of arguments to pass to the batch file
 */
async function collectDevBatVars(devbat: string, args: string[]): Promise<Map<string, string>|undefined> {
  const bat = [
    `@echo off`,
    `call "${devbat}" ${args.join(' ')} || exit`,
  ];
  for (const envvar of MSVC_ENVIRONMENT_VARIABLES) {
    bat.push(`echo ${envvar} := %${envvar}%`);
  }
  const fname = Math.random().toString() + '.bat';
  const batpath = path.join(paths.tmpDir, `vs-cmt-${fname}`);
  await fs.writeFile(batpath, bat.join('\r\n'));
  const res = await proc.execute(batpath, [], null, { shell: true, silent: true }).result;
  await fs.unlink(batpath);
  const output = (res.stdout)? res.stdout : res.stderr;

  if (res.retc !== 0) {
    if (output.includes('Invalid host architecture') || output.includes('Error in script usage')) {
      return;
    }

    console.log(`Error running ${devbat}`, output);
    return;
  }

  if (!output) {
    console.log(`Environment detection for using ${devbat} failed`);
    return;
  }

  const vars
    = output.split('\n').map(l => l.trim()).filter(l => l.length !== 0).reduce<Map<string, string>>((acc, line) => {
    const mat = /(\w+) := ?(.*)/.exec(line);
    if (mat) {
      acc.set(mat[1], mat[2]);
    } else {
      log.error(`Error parsing environment variable: ${line}`);
    }
    return acc;
  }, new Map());

  return vars;
}

/**
 * Platform arguments for VS Generators
 */
const VsArchitectures: {[key: string]: string} = {
  amd64: 'x64',
  arm: 'ARM',
  amd64_arm: 'ARM',
};

/**
 * Preferred CMake VS generators by VS version
 */
const VsGenerators: {[key: string]: string} = {
  11: 'Visual Studio 11 2012',
  VS120COMNTOOLS: 'Visual Studio 12 2013',
  12: 'Visual Studio 12 2013',
  VS140COMNTOOLS: 'Visual Studio 14 2015',
  14: 'Visual Studio 14 2015',
  15: 'Visual Studio 15 2017',
};

async function varsForVSInstallation(inst: VSInstallation, arch: string): Promise<Map<string, string>|null> {
  const common_dir = path.join(inst.installationPath, 'Common7', 'Tools');
  const devbat = path.join(common_dir, 'VsDevCmd.bat');
  const variables = await collectDevBatVars(devbat, ['-no_logo', `-arch=${arch}`]);
  if (!variables) {
    return null;
  } else {
    // This is a very *hacky* and sub-optimal solution, but it
    // works for now. This *helps* CMake make the right decision
    // when you have the release and pre-release edition of the same
    // VS version installed. I don't really know why or what causes
    // this issue, but this here seems to work. It basically just sets
    // the VS{vs_version_number}COMNTOOLS environment variable to contain
    // the path to the Common7 directory.
    const vs_version = variables.get('VISUALSTUDIOVERSION');
    if (vs_version) {
      variables.set(`VS${vs_version.replace('.', '')}COMNTOOLS`, common_dir);
    }

    // For Ninja and Makefile generators, CMake searches for some compilers
    // before it checks for cl.exe. We can force CMake to check cl.exe first by
    // setting the CC and CXX environment variables when we want to do a
    // configure.
    variables.set('CC', 'cl.exe');
    variables.set('CXX', 'cl.exe');
    return variables;
  }
}

/**
 * Try to get a VSKit from a VS installation and architecture
 */
async function tryCreateNewVCEnvironment(inst: VSInstallation, arch: string, pr?: ProgressReporter): Promise<Kit|null> {
  const realDisplayName: string|undefined
    = inst.displayName? inst.isPrerelease? `${inst.displayName} Preview` : inst.displayName : undefined;
  const installName = realDisplayName || inst.instanceId;
  const name = `${installName} - ${arch}`;
  log.debug('Checking for kit: ' + name);
  if (pr) {
    pr.report({ message: `Checking ${installName} with ${arch}` });
  }
  const variables = await varsForVSInstallation(inst, arch);
  if (!variables) {
    return null;
  }

  const kit: Kit = {
    name,
    toolchainBinaryPath: '',
    visualStudio: inst.instanceId,
    visualStudioArchitecture: arch,
  };

  const version = /^(\d+)+./.exec(inst.installationVersion);
  log.debug('Detected VsKit for version');
  log.debug(` DisplayName: ${realDisplayName}`);
  log.debug(` InstanceId: ${inst.instanceId}`);
  log.debug(` InstallVersion: ${inst.installationVersion}`);
  if (version) {
    const generatorName: string|undefined = VsGenerators[version[1]];
    if (generatorName) {
      log.debug(` Generator Present: ${generatorName}`);
      kit.preferredGenerator = {
        name: generatorName,
        platform: VsArchitectures[arch] as string || undefined,
      };
    }
    log.debug(` Selected Preferred Generator Name: ${generatorName}`);
  }

  return kit;
}

/**
 * Scans the system for Visual C++ installations using vswhere
 */
export async function scanForVSKits(pr?: ProgressReporter): Promise<Kit[]> {
  const installs = await vsInstallations();
  const prs = installs.map(async (inst): Promise<Kit[]> => {
    const ret = [] as Kit[];
    const arches = ['x86', 'amd64', 'x86_amd64', 'x86_arm', 'amd64_arm', 'amd64_x86'];
    const sub_prs = arches.map(arch => tryCreateNewVCEnvironment(inst, arch, pr));
    const maybe_kits = await Promise.all(sub_prs);
    maybe_kits.map(k => k? ret.push(k) : null);
    return ret;
  });
  const vs_kits = await Promise.all(prs);
  return ([] as Kit[]).concat(...vs_kits);
}

export async function getVSKitEnvironment(kit: Kit): Promise<Map<string, string>|null> {
  console.assert(kit.visualStudio);
  console.assert(kit.visualStudioArchitecture);
  const installs = await vsInstallations();
  const requested = installs.find(inst => inst.instanceId == kit.visualStudio);
  if (!requested) {
    return null;
  }
  return varsForVSInstallation(requested, kit.visualStudioArchitecture!);
}

/**
 * Search for Kits available on the platform.
 * @returns A list of Kits.
 */
export async function scanForKits(scanPaths: string[] = []) {
  log.info('Scanning for Kits on system');
  const prog = {
    location: vscode.ProgressLocation.Notification,
    title: 'Scanning for kits',
  };
  return vscode.window.withProgress(prog, async pr => {
    pr.report({ message: 'Scanning for CMake kits...' });
    // Search directories on `PATH` for compiler binaries

    if (scanPaths && scanPaths.length) {
      // Search them all in parallel
      let prs = [] as Promise<Kit[]>[];
      const compiler_kits = scanPaths.map(path_el => scanDirForCompilerKits(path_el, pr));
      prs = prs.concat(compiler_kits);
      const arrays = await Promise.all(prs);
      const kits = ([] as Kit[]).concat(...arrays);
      kits.map(k => log.info(`Found Kit: ${k.name}`));
      log.info('Scanning for Kits complete,', kits.length, 'Found');
      return kits;
    } else {
      log.info(`Path variable empty`);
      return [];
    }
  });
}

/**
 * Generates a string description of a kit. This is shown to the user.
 * @param kit The kit to generate a description for
 */
function descriptionForKit(kit: Kit) {
  if (kit.toolchainFile) {
    return `Kit for toolchain file ${kit.toolchainFile}`;
  }
  if (kit.visualStudio) {
    return `Using compilers for ${kit.visualStudio} (${kit.visualStudioArchitecture} architecture)`;
  }
  if (kit.compilers) {
    const compilers = Object.keys(kit.compilers).map(k => `${k} = ${kit.compilers![k]}`);
    return `Using compilers: ${compilers.join(', ')}`;
  }
  return 'Unspecified (Let CMake guess what compilers and environment to use)';
}

export async function readKitsFile(filepath: string): Promise<Kit[]> {
  if (!await fs.exists(filepath)) {
    log.debug(`Not reading non-existent kits file: ${filepath}`);
    return [];
  }
  log.debug('Reading kits file', filepath);
  const content_str = await fs.readFile(filepath);
  let kits_raw: object[] = [];
  try {
    kits_raw = json5.parse(content_str.toLocaleString());
  } catch (e) {
    log.error('Failed to parse cmake-kits.json:', e);
    return [];
  }
  const validator = await loadSchema('schemas/kits-schema.json');
  const is_valid = validator(kits_raw);
  if (!is_valid) {
    const errors = validator.errors!;
    log.error(`Invalid cmake-kits.json (${filepath}):`);
    for (const err of errors) {
      log.error(` >> ${err.dataPath}: ${err.message}`);
    }
    return [];
  }
  const kits = kits_raw as Kit[];
  log.info(`Successfully loaded ${kits.length} kits from ${filepath}`);
  return dropNulls(kits);
}

/**
 * Class that manages and tracks Kits
 */
export class KitManager implements vscode.Disposable {
  /**
   * The known kits
   */
  get kits() {
    return this._kits;
  }

  private _kits = [] as Kit[];

  /**
   * The path to the user-specific `cmake-kits.json` file
   */
  private readonly _userKitsPath: string;

  /**
   * Watches the file at `_kitsPath`.
   */
  private readonly _kitsWatcher: MultiWatcher;

  /**
   * The active build kit
   */
  get activeKit() {
    return this._activeKit;
  }

  private _activeKit: Kit|null = null;

  /**
   * The kit manager has a selected kit.
   */
  get hasActiveKit() {
    return this._activeKit !== null;
  }

  /**
   * Event emitted when the Kit changes. This can be via user action, by the
   * available kits changing, or on initial load when the prior workspace kit
   * is reloaded.
   */
  get onActiveKitChanged() {
    return this._activeKitChangedEmitter.event;
  }

  private readonly _activeKitChangedEmitter = new vscode.EventEmitter<Kit|null>();

  /**
   * Change the current kit. Commits the current kit name to workspace-local
   * persistent state so that the same kit is reloaded when the user opens
   * the workspace again.
   * @param kit The new Kit
   */
  private _setActiveKit(kit: Kit|null) {
    log.debug('Active kit set to', kit? kit.name : 'null');
    if (kit) {
      this.state.activeKitName = kit.name;
    } else {
      this.state.activeKitName = null;
    }
    this._activeKit = kit;
    this._activeKitChangedEmitter.fire(kit);
  }

  /**
   * Create a new kit manager.
   */
  constructor(readonly state: StateManager, readonly config: ConfigurationReader) {
    log.debug('Constructing KitManager');
    this._userKitsPath = path.join(vscode.env.appRoot, 'packages', 'cmake-kits.json');

    // Re-read the kits file when it is changed
    this._kitsWatcher = new MultiWatcher(this._userKitsPath);
    this._kitsWatcher.onAnyEvent(_e => this._rereadKits());
  }

  /**
   * Dispose the kit manager
   */
  dispose() {
    log.debug('Disposing KitManager');
    this._kitsWatcher.dispose();
    this._activeKitChangedEmitter.dispose();
  }

  /**
   * Shows a QuickPick that lets the user select a new kit.
   * @returns The selected Kit, or `null` if the user cancelled the selection
   * @note The user cannot reset the active kit to `null`. If they make no
   * selection, the current kit is kept. The only way it can reset to `null` is
   * if the active kit becomes somehow unavailable.
   */
  async selectKit(): Promise<Kit|null> {
    log.info(`Start selection of kits. ${this._kits.length} kits available.`);

    if (!this._kits.length) {
      await this.rescanForKits();
      if (this._kits.length === 1) {
        log.info(`Only one kit, selected.`);
        this._setActiveKit(this._kits[0]);
        return this._kits[0];
      }
    }

    if (this._kits.length === 0) {
      interface FirstScanItem extends vscode.MessageItem {
        action: 'openConfig'|'cancel';
      }

      const choices: FirstScanItem[] = [
        {
          title: 'Fix configuration',
          action: 'openConfig',
        },
        {
          title: 'Close',
          isCloseAffordance: true,
          action: 'cancel',
        },
      ];
      const chosen = await vscode.window.showInformationMessage(
        'No CMake kits are available. What would you like to do?',
        {
          modal: true,
        },
        ...choices,
      );
      if (!chosen) {
        return null;
      }
      switch (chosen.action) {
      case 'openConfig': {
        await vscode.commands.executeCommand('workbench.action.openSettings2');
        return null;
      }
      case 'cancel': {
        return null;
      }
      }
    } else if (this._kits.length === 1) {
      log.info(`Only one kit, selected.`);
      this._setActiveKit(this._kits[0]);
      return this._kits[0];
    }

    interface KitItem extends vscode.QuickPickItem {
      kit: Kit;
    }

    log.info('Opening kit selection QuickPick');
    const items = this._kits.map((kit): KitItem => {
      return {
        label: kit.name !== '__unspec__'? kit.name : '[Unspecified]',
        description: descriptionForKit(kit),
        kit,
      };
    });
    const chosen_kit = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Kit',
    });
    if (chosen_kit === undefined) {
      log.debug('User cancelled Kit selection');
      // No selection was made
      return null;
    } else {
      log.debug('User selected kit ', JSON.stringify(chosen_kit));
      this._setActiveKit(chosen_kit.kit);
      return chosen_kit.kit;
    }
  }

  async selectKitByName(kitName: string): Promise<Kit|null> {
    log.debug('Setting active Kit by name', kitName);
    const chosen = this._kits.find(k => k.name == kitName);
    if (chosen === undefined) {
      log.warning('Kit set by name to non-existent kit:', kitName);
      return null;
    } else {
      this._setActiveKit(chosen);
      return chosen;
    }
  }

  /**
   * Rescan the system for kits.
   *
   * This will update the `cmake-kits.json` file with any newly discovered kits,
   * and rewrite any previously discovered kits with the new data.
   */
  async rescanForKits() {
    log.debug('Rescanning for Kits');
    // clang-format off
    const toolchainPath = await findItem('toolchain/bin');
    if (!toolchainPath) {
      log.error('Kits folder did not exists');
      await fs.writeFile(this._userKitsPath, '[]');
      return;
    }

    const discovered_kits = await scanForKits([toolchainPath]);
    const new_kits_by_name = discovered_kits.reduce(
      (acc, new_kit) => {
        acc[new_kit.name] = new_kit;
        return acc;
      },
      {} as{[kit: string]: Kit},
    );
    // clang-format on

    const new_kits = Object.keys(new_kits_by_name).map(k => new_kits_by_name[k]);

    log.debug('Saving new kits to', this._userKitsPath);
    await fs.mkdir_p(path.dirname(this._userKitsPath));
    const stripped_kits = new_kits.filter(k => k.name !== '__unspec__');
    const sorted_kits = stripped_kits.sort((a, b) => {
      if (a.name == b.name) {
        return 0;
      } else if (a.name < b.name) {
        return -1;
      } else {
        return 1;
      }
    });
    await fs.writeFile(this._userKitsPath, JSON.stringify(sorted_kits, null, 2));
    // Sometimes the kit watcher does fire?? May be an upstream bug, so we'll
    // re-read now
    await this._rereadKits();
    log.debug(this._userKitsPath, 'saved');
  }

  /**
   * Reread the `cmake-kits.json` file. This will be called if we write the
   * file in `rescanForKits`, or if the user otherwise edits the file manually.
   */
  private async _rereadKits() {
    const kits_acc: Kit[] = [];
    const usable_kits: Kit[] = [];
    for (const kit of await readKitsFile(this._userKitsPath)) {
      if (!kit.compilers) {
        continue;
      }
      const testFile = kit.compilers[Object.keys(kit.compilers)[0]];

      if (!await fs.exists(testFile)) {
        log.warning('kit is removed:', testFile);
        return [];
      }

      usable_kits.push(kit);
    }
    kits_acc.push(...usable_kits);
    // Set the current kit to the one we have named
    this._kits = kits_acc;
    const already_active_kit = this._kits.find(kit => kit.name === this.state.activeKitName);
    this._setActiveKit(already_active_kit || null);
  }

  /**
   * Initialize the kits manager. Must be called before using an instance.
   */
  async initialize() {
    log.debug('Second phase init for KitManager');
    if (await fs.exists(this._userKitsPath)) {
      log.debug('Re-read kits file from prior session');
      // Load up the list of kits that we've saved
      await this._rereadKits();
    } else {
      await this.rescanForKits();
    }
  }

  /**
   * Opens a text editor with the user-local `cmake-kits.json` file.
   */
  async openKitsEditor() {
    log.debug('Opening TextEditor for', this._userKitsPath);
    const text = await vscode.workspace.openTextDocument(this._userKitsPath);
    return vscode.window.showTextDocument(text);
  }
}

export function kitChangeNeedsClean(newKit: Kit, oldKit: Kit|null): boolean {
  if (!oldKit) {
    // First kit? We never clean
    log.debug('Clean not needed: No prior Kit selected');
    return false;
  }
  const important_params = (k: Kit) => ({
    compilers: k.compilers,
    vs: k.visualStudio,
    vsArch: k.visualStudioArchitecture,
    tc: k.toolchainFile,
  });
  const new_imp = important_params(newKit);
  const old_imp = important_params(oldKit);
  if (compare(new_imp, old_imp) != Ordering.Equivalent) {
    log.debug('Need clean: Kit changed');
    return true;
  } else {
    return false;
  }
}