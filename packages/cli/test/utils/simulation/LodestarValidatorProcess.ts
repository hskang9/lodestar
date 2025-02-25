import {join} from "node:path";
import {ChildProcess} from "node:child_process";
import {mkdir, writeFile} from "node:fs/promises";
import type {SecretKey} from "@chainsafe/bls/types";
import {Api, getClient} from "@lodestar/api/keymanager";
import {Keystore} from "@chainsafe/bls-keystore";
import {IChainForkConfig} from "@lodestar/config";
import {interopSecretKey} from "@lodestar/state-transition";
import {IGlobalArgs} from "../../../src/options/globalOptions.js";
import {IValidatorCliArgs} from "../../../src/cmds/validator/options.js";
import {SimulationParams, ValidatorConstructor, ValidatorProcess} from "./types.js";
import {closeChildProcess, KEY_MANAGER_BASE_PORT, spawnProcessAndWait, __dirname} from "./utils.js";
import {ExternalSignerServer} from "./ExternalSignerServer.js";
/* eslint-disable no-console */
// eslint-disable-next-line @typescript-eslint/naming-convention
export const LodestarValidatorProcess: ValidatorConstructor = class LodestarValidatorProcess
  implements ValidatorProcess {
  static totalProcessCount = 0;
  readonly params: SimulationParams;
  readonly address = "127.0.0.1";
  readonly keyManagerPort: number;
  readonly id: string;
  readonly keyManagerApi: Api;
  readonly secretKeys: SecretKey[] = [];
  readonly externalSigner: ExternalSignerServer;

  private rootDir: string;
  private clientIndex: number;
  private validatorProcess!: ChildProcess;
  private rcConfig: IValidatorCliArgs & IGlobalArgs;
  private forkConfig: IChainForkConfig;

  constructor(
    params: SimulationParams,
    {
      rootDir,
      clientIndex,
      server,
      config,
    }: {
      rootDir: string;
      clientIndex: number;
      server: string;
      config: IChainForkConfig;
    }
  ) {
    this.params = params;
    this.rootDir = rootDir;
    this.clientIndex = clientIndex;
    LodestarValidatorProcess.totalProcessCount += 1;

    this.keyManagerPort = KEY_MANAGER_BASE_PORT + LodestarValidatorProcess.totalProcessCount;
    this.id = `VAL-${LodestarValidatorProcess.totalProcessCount}`;
    this.forkConfig = config;

    const validatorSecretKeys = Array.from({length: this.params.validatorsPerClient}, (_, i) => {
      return interopSecretKey(this.clientIndex * this.params.validatorsPerClient + i);
    });
    this.secretKeys = validatorSecretKeys;

    // Split half of the keys to external signer
    this.externalSigner = new ExternalSignerServer(
      this.secretKeys.slice(0, this.secretKeys.length * this.params.externalKeysPercentage)
    );

    this.rcConfig = ({
      network: "dev",
      preset: "minimal",
      dataDir: join(this.rootDir, this.id),
      server,
      keymanager: true,
      "keymanager.authEnabled": false,
      "keymanager.address": this.address,
      "keymanager.port": this.keyManagerPort,
      "params.SECONDS_PER_SLOT": String(this.params.secondsPerSlot),
      "params.GENESIS_DELAY": String(this.params.genesisSlotsDelay),
      "params.ALTAIR_FORK_EPOCH": String(this.params.altairEpoch),
      "params.BELLATRIX_FORK_EPOCH": String(this.params.bellatrixEpoch),
      logPrefix: this.id,
      logFormatGenesisTime: this.params.genesisTime,
      logFile: join(this.params.logFilesDir, `${this.id}.log`),
      logFileLevel: "debug",
      logLevel: "info",
      logFileDailyRotate: 0,
    } as unknown) as IValidatorCliArgs & IGlobalArgs;

    this.keyManagerApi = getClient(
      {baseUrl: `http://${this.address}:${this.keyManagerPort}`},
      {config: this.forkConfig}
    );
  }

  async start(): Promise<void> {
    await mkdir(this.rootDir);
    await mkdir(`${this.rootDir}/keystores`);

    await writeFile(join(this.rootDir, "password.txt"), "password");
    await writeFile(join(this.rootDir, "rc_config.json"), JSON.stringify(this.rcConfig, null, 2));

    // Split half of the keys to the keymanager
    for (const key of this.secretKeys.slice(this.secretKeys.length * this.params.externalKeysPercentage)) {
      const keystore = await Keystore.create("password", key.toBytes(), key.toPublicKey().toBytes(), "");
      await writeFile(
        join(this.rootDir, "keystores", `${key.toPublicKey().toHex()}.json`),
        JSON.stringify(keystore.toObject(), null, 2)
      );
    }

    await this.externalSigner.start();

    console.log(`Starting lodestar validator "${this.id}".`, {dataDir: this.rootDir});

    this.validatorProcess = await spawnProcessAndWait(
      `${__dirname}/../../../bin/lodestar.js`,
      [
        "validator",
        "--network",
        "dev",
        "--rcConfig",
        `${this.rootDir}/rc_config.json`,
        "--importKeystores",
        `${this.rootDir}/keystores`,
        "--importKeystoresPassword",
        `${this.rootDir}/password.txt`,
      ],
      async () => this.ready(),
      `Waiting for "${this.id}" to start.`
    );

    // Import half of the keys to the keymanager from external signer
    await this.keyManagerApi.importRemoteKeys(
      this.secretKeys
        .slice(0, this.secretKeys.length / 2)
        .map((sk) => ({pubkey: sk.toPublicKey().toHex(), url: this.externalSigner.url}))
    );

    console.log(`Validator "${this.id}" started.`);
  }

  async stop(): Promise<void> {
    console.log(`Stopping validator "${this.id}".`);

    if (this.validatorProcess !== undefined) {
      await closeChildProcess(this.validatorProcess);
    }

    await this.externalSigner.stop();
  }

  async ready(): Promise<boolean> {
    try {
      await this.keyManagerApi.listKeys();
      return true;
    } catch {
      return false;
    }
  }
};
