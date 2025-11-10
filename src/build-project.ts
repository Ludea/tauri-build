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
  args?: string[]
  target?: string
}

export async function buildProject(options: BuildOptions): Promise<string[]> {
  const args: string[] = options.args ?? []

  if (options.debug) {
    args.push('--debug')
  }

  if (options.configPath) {
    args.push('--config', options.configPath)
  }

  if (options.target) {
    args.push('--target', options.target)
  }

  if (options.projectPath) {
    const newCwd = resolve(process.cwd(), options.projectPath)
    core.debug(`changing working directory: ${process.cwd()} -> ${newCwd}`)
    process.chdir(newCwd)
  }

  if (options.runner) {
    core.info(`running ${options.runner} with args: build ${args.join(' ')}`)
    await spawnCmd(options.runner, ['build', ...args])
  } else {
    core.info(`running builtin runner with args: build ${args.join(' ')}`)
    await run(['build', ...args], '')
  }

  const crateDir = await glob(`./**/Cargo.toml`).then(([manifest]) =>
    join(process.cwd(), dirname(manifest))
  )
  const metaRaw = await execCmd(
    'cargo',
    ['metadata', '--no-deps', '--format-version', '1'],
    {cwd: crateDir}
  )

  const meta: unknown = JSON.parse(metaRaw)

let targetDir: string | undefined;

if (
  typeof meta === "object" &&
  meta !== null &&
  "target_directory" in meta &&
  typeof (meta as { target_directory: unknown }).target_directory === "string"
) {
  targetDir = (meta as { target_directory: string }).target_directory;
} else {
  throw new Error("Invalid meta format");
}

  const profile = options.debug ? 'debug' : 'release'
  const bundleDir = options.target
    ? join(targetDir, options.target, profile, 'bundle')
    : join(targetDir, profile, 'bundle')

  const macOSExts = ['app', 'app.tar.gz', 'app.tar.gz.sig', 'dmg']
  const linuxExts = [
    'AppImage',
    'AppImage.tar.gz',
    'AppImage.tar.gz.sig',
    'deb',
    'rpm'
  ]
  const windowsExts = [
    'exe',
    'exe.zip',
    'exe.zip.sig',
    'msi',
    'msi.zip',
    'msi.zip.sig'
  ]

  const artifactsLookupPattern = `${bundleDir}/*/!(linuxdeploy)*.{${[
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

    child.stdin.on('error', error => {
      reject(error)
    })
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
            )}. reason: ${error.message}`
          )
          const Rejecterror = new Error(stderr);
          reject(Rejecterror)
        } else {
          resolve(stdout)
        }
      }
    )
  })
}
