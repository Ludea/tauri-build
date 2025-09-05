import {run} from '@tauri-apps/cli'
import {basename, dirname, join, resolve} from 'path'
import glob from 'tiny-glob'
import * as core from '@actions/core'
import {
  exec,
  ExecOptionsWithStringEncoding,
  spawn,
  SpawnOptionsWithoutStdio
} from 'child_process'

interface BuildOptions {
  runner?: string
  projectPath?: string
  configPath?: string
  debug?: boolean
  mobile?: string
  args?: string[]
  target?: string
}

export async function buildProject(options: BuildOptions): Promise<string[]> {
  const args: string[] = options.args || []

  const android =
    (process.platform === 'linux' && options.mobile === 'true') ||
    options.mobile === 'android'
  const ios =
    process.platform === 'darwin' &&
    (options.mobile === 'true' || options.mobile === 'ios')

  if (options.debug) {
    args.push('--debug')
  }

  if (options.configPath) {
    args.push('--config', options.configPath)
  }

  if (options.target) {
    args.push('--target', options.target)
  }

  if (android) {
    args.push('--apk')
    args.push('--split-per-abi')
  }

  if (options.projectPath) {
    const newCwd = resolve(process.cwd(), options.projectPath)
    core.debug(`changing working directory: ${process.cwd()} -> ${newCwd}`)
    process.chdir(newCwd)
  }

  if (options.runner) {
    core.info(`running ${options.runner} with args: android ${args.join(' ')}`)
    await spawnCmd(options.runner, [
      android ? 'android' : ios ? 'ios' : '',
      'build',
      ...args
    ])
  } else {
    core.info(`running builtin runner with args: build ${args.join(' ')}`)
    await run(
      [
        android
          ? 'android build --apk --target aarch64 --split-per-abi'
          : ios
            ? 'ios build'
            : 'build',
        ...args
      ],
      ''
    )
  }

  const crateDir = await glob(`./**/Cargo.toml`).then(([manifest]) =>
    join(process.cwd(), dirname(manifest))
  )
  const metaRaw = await execCmd(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1'],
    {cwd: crateDir}
  )
  const meta = JSON.parse(metaRaw)
  const targetDir = meta.target_directory
  const workspaceRoot = meta.workspace_root

  const profile = options.debug ? 'debug' : 'release'
  const desktopBundleDir = options.target
    ? join(targetDir, options.target, profile, 'bundle')
    : join(targetDir, profile, 'bundle')
  const mobileBundleDir = join(
    workspaceRoot,
    'gen',
    android ? 'android' : ios ? 'ios' : '',
    'app',
    'build',
    'outputs',
    'apk',
    'arm64',
    profile
  )
  const macOSExts = ['app', 'app.tar.gz', 'app.tar.gz.sig', 'dmg']
  const linuxExts = [
    'AppImage',
    'AppImage.tar.gz',
    'AppImage.tar.gz.sig',
    'deb',
    'rpm'
  ]
  const androidExts = ['apk']
  const windowsExts = [
    'exe',
    'exe.zip',
    'exe.zip.sig',
    'msi',
    'msi.zip',
    'msi.zip.sig'
  ]

  const artifactsLookupPattern = `${desktopBundleDir}/*/!(linuxdeploy)*.{${[
    ...macOSExts,
    linuxExts,
    windowsExts
  ].join(',')}}`

  core.debug(
    `Looking for artifacts using this pattern: ${artifactsLookupPattern}`
  )

  const artifacts = await glob(artifactsLookupPattern, {
    absolute: true,
    filesOnly: false
  })

  let i = 0
  for (const artifact of artifacts) {
    if (
      artifact.endsWith('.app') &&
      !artifacts.some(a => a.endsWith('.app.tar.gz'))
    ) {
      await execCmd('tar', [
        'czf',
        `${artifact}.tar.gz`,
        '-C',
        dirname(artifact),
        basename(artifact)
      ])
      artifacts[i] += '.tar.gz'
    } else if (artifact.endsWith('.app')) {
      // we can't upload a directory
      artifacts.splice(i, 1)
    }

    i++
  }

  return artifacts
}

async function spawnCmd(
  cmd: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      ...options,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: true
    })

    child.on('exit', () => resolve)

    child.on('error', error => {
      reject(error)
    })

    if (child.stdin) {
      child.stdin.on('error', error => {
        reject(error)
      })
    }
  })
}

async function execCmd(
  cmd: string,
  args: string[],
  options: Omit<ExecOptionsWithStringEncoding, 'encoding'> = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `${cmd} ${args.join(' ')}`,
      {...options, encoding: 'utf-8'},
      (error, stdout, stderr) => {
        if (error) {
          console.error(
            `Failed to execute cmd ${cmd} with args: ${args.join(
              ' '
            )}. reason: ${error}`
          )
          reject(stderr)
        } else {
          resolve(stdout)
        }
      }
    )
  })
}
