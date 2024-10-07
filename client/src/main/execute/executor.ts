import * as os from "os";
// @ts-ignore
import player from 'node-wav-player';
import Active from "../active";
import API from "../api";
import InsertHistory from "./insert-history";
import Log from "../log";
import MainWindow from "../windows/main";
import MiniModeWindow from "../windows/mini-mode";
import NativeCommands from "./native-commands";
import NUX from "../nux";
import PluginManager from "../ipc/plugin-manager";
import RendererBridge from "../bridge";
import RevisionBoxWindow from "../windows/revision-box";
import Settings from "../settings";
import Stream from "../stream/stream";
import System from "./system";
import { core } from "../../gen/core";
import { commandTypeToString, isMetaResponse, isValidAlternative } from "../../shared/alternatives";
import path from "path";

export default class Executor {
  private chainFinishedPromise = Promise.resolve();
  private lastEndpointId: string = "";
  private miniModeHideTimeout?: NodeJS.Timeout;
  private pending?: core.ICommandsResponse;
  private resolveChainFinished = () => {};
  private log: Log;
  private fileFolder = "static/audio/feedback/"
  private feedbackFileMap: { [key: string]: string } = {
    FAIL_ALL: "fail_all.wav",
    FAIL_CHOOSE: "fail_choose.wav",
    SUCCESS_HIT: "success_hit.wav",
    SUCCESS_HIT_CHOOSE: "success_hit_choose.wav",
    SUCCESS_CHOOSE: "success_choose.wav",
  };

  constructor(
    private active: Active,
    private api: API,
    private bridge: RendererBridge,
    private insertHistory: InsertHistory,
    private mainWindow: MainWindow,
    private miniModeWindow: MiniModeWindow,
    private nativeCommands: NativeCommands,
    private nux: NUX,
    private pluginManager: PluginManager,
    private revisionBoxWindow: RevisionBoxWindow,
    private settings: Settings,
    private stream: Stream,
    private system: System,
    private commandHandler: () => any
  ) {
    this.newChainFinishedPromise();
    this.log = new Log(this.settings, "Executor");
  }

  private addToHistory(response: core.ICommandsResponse) {
    if (
      !response.execute ||
      (response.execute.commands || []).some(
        (command) =>
          command.type == core.CommandType.COMMAND_TYPE_USE ||
          command.type == core.CommandType.COMMAND_TYPE_CANCEL
      )
    ) {
      return;
    }

    this.stream.sendCallbackRequest({
      type: core.CallbackType.CALLBACK_TYPE_ADD_TO_HISTORY,
      text: response.execute.transcript!,
    });
  }

  private async checkClickable(command: core.ICommand, clickables: any[]): Promise<boolean> {
    if (this.active.isFirstPartyBrowser() && this.active.pluginConnected()) {
      const clickableResult = await this.pluginManager.sendCommandToApp(this.active.app, {
        type: core.CommandType.COMMAND_TYPE_CLICKABLE,
        path: command.path,
      });

      return clickableResult && clickableResult.data.clickable;
    } else if (this.active.app == "system dialog") {
      return clickables.indexOf(command.path) > -1;
    }

    return false;
  }

  private async handleResponseFromPlugin(forwarded: any) {
    // ChunkManager calls this with await this.executor.execute(this.response); so we want to be sure that
    // all the commands in a chain are executed before this returns. In the branch above, if there are
    // remaining commands, send a text request to run the next one and await this.chainFinishedPromise.
    // By the time we reach this branch, we will have executed all the remaining commands, so we want to resolve
    // this.chainFinishedPromise by calling its resolve function, this.resolveChainFinished, and make a new one.
    this.resolveChainFinished();
    this.newChainFinishedPromise();

    if (forwarded && forwarded.message) {
      if (forwarded.message == "callback") {
        await this.stream.sendEditorStateRequest();
        this.stream.sendCallbackRequest({
          type: forwarded.data.type,
        });
      } else if (forwarded.message == "sendText") {
        this.stream.sendTextRequest(forwarded.data.text, true);
      } else if (forwarded.message == "open") {
        await this.stream.sendEditorStateRequest();
        this.stream.sendCallbackRequest({
          type: core.CallbackType.CALLBACK_TYPE_OPEN_FILE,
        });
      } else if (forwarded.message == "paste") {
        // remove once deprecated from the chrome extension
        await this.system.pressKey("v", [os.platform() === "darwin" ? "command" : "control"]);
      }
    }
  }

  private hasExecute(response: core.ICommandsResponse): boolean {
    return !!(
      response.execute &&
      response.execute.commands &&
      response.execute.commands.length > 0
    );
  }

  private async invalidateBadApplicationCommands(
    response: core.ICommandsResponse,
    getApps: () => Promise<string[]>,
    shouldCheck: (command: core.ICommand) => boolean
  ): Promise<any> {
    if (
      response.alternatives &&
      response.alternatives.length > 0 &&
      response.alternatives.some((alternative: core.ICommandsResponseAlternative) =>
        (alternative.commands || []).some((command: core.ICommand) => shouldCheck(command))
      )
    ) {
      const apps = await getApps();
      let seen: { [k: string]: boolean } = {};
      for (let i = 0; i < response.alternatives.length; i++) {
        const alternative = response.alternatives[i];
        if (
          !alternative.commands ||
          alternative.commands.every((command: core.ICommand) => !shouldCheck(command))
        ) {
          continue;
        }

        const matches = await this.system.applicationMatches(alternative.commands[0].text!, apps);
        if (matches.length == 0 || seen[matches[0]]) {
          alternative.commands[0].type = core.CommandType.COMMAND_TYPE_INVALID;
        } else {
          seen[matches[0]] = true;
        }
      }

      if (
        response.execute &&
        response.execute.commands &&
        this.hasExecute(response) &&
        (await this.system.applicationMatches(response.execute.commands[0].text!, apps).length) == 0
      ) {
        response.execute = null;
      }
    }

    return response;
  }

  private async invalidateBadClickCommands(response: core.ICommandsResponse): Promise<any> {
    // invalidate click commands that don't correspond to any elements on the page
    if (
      response.alternatives &&
      response.alternatives.length > 0 &&
      response.alternatives
        .filter((e: core.ICommandsResponseAlternative) => isValidAlternative(e))
        .find((e: core.ICommandsResponseAlternative) => e.transcript!.startsWith("click "))
    ) {
      const clickables = await this.system.clickable();
      for (let i = 0; i < response.alternatives.length; i++) {
        if (!response.alternatives[i].transcript!.startsWith("click ")) {
          continue;
        }

        let command = response.alternatives[i].commands![0];
        if (!(await this.checkClickable(command, clickables))) {
          command.type = core.CommandType.COMMAND_TYPE_INVALID;
        }
      }

      return response;
    }

    return response;
  }

  private async invalidateBadUseCommands(response: core.ICommandsResponse): Promise<any> {
    // invalidate use commands that are too big for the pending list
    const isInvalid = async (alternative: core.ICommandsResponseAlternative) => {
      if (!alternative) {
        return true;
      }

      const use = (alternative.commands || []).filter(
        (e: core.ICommand) => e.type == core.CommandType.COMMAND_TYPE_USE
      );

      const invalidPending =
        use.length > 0 &&
        (!this.pending || (this.pending && use[0].index! > this.pending.alternatives!.length));

      if (this.active.isFirstPartyBrowser() && this.active.pluginConnected()) {
        let invalidChrome = false;
        if (use.length > 0) {
          const clickableResult = await this.pluginManager.sendCommandToApp(this.active.app, {
            type: core.CommandType.COMMAND_TYPE_CLICKABLE,
            path: use[0].index!.toString(),
          });

          if (!clickableResult || !clickableResult.data.clickable) {
            invalidChrome = true;
          } else {
            // the extension tells us there's a valid command, so don't run any pending command on the client too
            this.clearPending();
          }
        }

        return invalidChrome && invalidPending;
      } else {
        return invalidPending;
      }
    };

    if (response.alternatives) {
      for (let i = 0; i < response.alternatives.length; i++) {
        if ((await isInvalid(response.alternatives[i])) && response.alternatives[i].commands) {
          response.alternatives[i].commands!.map((e: core.ICommand) => {
            e.type = core.CommandType.COMMAND_TYPE_INVALID;
          });
        }
      }
    }

    if (response.execute && (await isInvalid(response.execute))) {
      response.execute = null;
    }

    return response;
  }

  private async invalidateMaxKeystrokeCommands(response: any): Promise<any> {
    const state = await this.active.getEditorState();
    for (let alternative of response.alternatives) {
      let count: number = 0;
      for (const command of alternative.commands) {
        const commandType = command.type;
        if (commandType == core.CommandType.COMMAND_TYPE_DIFF && !state.canSetState) {
          count += this.nativeCommands.diffKeystrokesCount(state, command);
        } else if (commandType == core.CommandType.COMMAND_TYPE_INSERT) {
          count += this.nativeCommands.insertKeystrokesCount(state, command.text);
        } else if (
          commandType == core.CommandType.COMMAND_TYPE_UNDO &&
          this.nativeCommands.needsUndoStack(state) &&
          this.nativeCommands.canUndo(state)
        ) {
          count += this.nativeCommands.undoKeystrokesCount(state);
        } else if (
          commandType == core.CommandType.COMMAND_TYPE_REDO &&
          this.nativeCommands.needsUndoStack(state) &&
          this.nativeCommands.canRedo()
        ) {
          count += this.nativeCommands.redoKeystrokesCount(state);
        }
      }

      if (count >= this.nativeCommands.maxKeystrokes) {
        alternative.description = "Too many keystrokes: " + alternative.description;
        alternative.commands.map((e: any) => {
          e.type = core.CommandType.COMMAND_TYPE_INVALID;
        });
      }
    }

    return response;
  }

  private newChainFinishedPromise() {
    this.chainFinishedPromise = new Promise((resolve) => {
      this.resolveChainFinished = resolve;
    });
  }

  private removeCommandsForUseOrCancel(response: core.ICommandsResponse): any {
    if (isMetaResponse(response) && response.alternatives && response.alternatives.length > 0) {
      response.execute = response.alternatives[0];
      response.alternatives = [];
    }

    return response;
  }

  private savePendingResponseIfNeeded(response: core.ICommandsResponse) {
    // ignore execute-only responses
    if (
      (!response.alternatives || response.alternatives.length == 0) &&
      this.hasExecute(response)
    ) {
      return;
    }

    const filteredResponse = new core.CommandsResponse({
      endpointId: response.endpointId!,
      alternatives: response.alternatives!.filter((e: core.ICommandsResponseAlternative) =>
        isValidAlternative(e)
      ),
    });

    this.pending = filteredResponse;
  }

  private setExecuteToFirstAlternativeIfNeeded(response: core.ICommandsResponse): any {
    const valid = (response.alternatives || []).filter((e: core.ICommandsResponseAlternative) =>
      isValidAlternative(e)
    );

    if (this.hasExecute(response) || valid.length == 0) {
      return response;
    }

    const autoExecuteCommandTypes: core.CommandType[] = [
      core.CommandType.COMMAND_TYPE_DIFF,
      core.CommandType.COMMAND_TYPE_CANCEL,
      core.CommandType.COMMAND_TYPE_CLIPBOARD,
      core.CommandType.COMMAND_TYPE_COPY,
      core.CommandType.COMMAND_TYPE_INSERT,
      core.CommandType.COMMAND_TYPE_SCROLL,
      core.CommandType.COMMAND_TYPE_LANGUAGE_MODE,
      core.CommandType.COMMAND_TYPE_NEXT,
      core.CommandType.COMMAND_TYPE_PASTE,
      core.CommandType.COMMAND_TYPE_PAUSE,
      core.CommandType.COMMAND_TYPE_REDO,
      core.CommandType.COMMAND_TYPE_SAVE,
      core.CommandType.COMMAND_TYPE_SHOW,
      core.CommandType.COMMAND_TYPE_UNDO,
      core.CommandType.COMMAND_TYPE_USE,
      core.CommandType.COMMAND_TYPE_DEBUGGER_CONTINUE,
      core.CommandType.COMMAND_TYPE_DEBUGGER_INLINE_BREAKPOINT,
      core.CommandType.COMMAND_TYPE_DEBUGGER_PAUSE,
      core.CommandType.COMMAND_TYPE_DEBUGGER_SHOW_HOVER,
      core.CommandType.COMMAND_TYPE_DEBUGGER_START,
      core.CommandType.COMMAND_TYPE_DEBUGGER_STEP_INTO,
      core.CommandType.COMMAND_TYPE_DEBUGGER_STEP_OUT,
      core.CommandType.COMMAND_TYPE_DEBUGGER_STEP_OVER,
      core.CommandType.COMMAND_TYPE_DEBUGGER_STOP,
      core.CommandType.COMMAND_TYPE_DEBUGGER_TOGGLE_BREAKPOINT,
      core.CommandType.COMMAND_TYPE_START_DICTATE,
      core.CommandType.COMMAND_TYPE_STOP_DICTATE,
      core.CommandType.COMMAND_TYPE_SHOW_REVISION_BOX,
      core.CommandType.COMMAND_TYPE_HIDE_REVISION_BOX,
    ];

    const executeKeys: string[] = [
      "up",
      "down",
      "left",
      "right",
      "space",
      "enter",
      "tab",
      "pagedown",
      "pageup",
    ];

    if (!valid[0].transcript || !valid[0].commands || valid[0].commands.length == 0) {
      return response;
    }

    // run commands are often in a terminal, where we don't want to do things unexpectedly
    if (valid[0].transcript.startsWith("run")) {
      return response;
    }

    if (
      valid.length == 1 ||
      valid[0].commands.every(
        (e) =>
          autoExecuteCommandTypes.includes(e.type || core.CommandType.COMMAND_TYPE_NONE) ||
          (e.type == core.CommandType.COMMAND_TYPE_PRESS && executeKeys.includes(e.text || ""))
      )
    ) {
      response.execute = valid[0];
    } else if (valid[0].commands[0].type == core.CommandType.COMMAND_TYPE_CUSTOM) {
      const custom = this.active.customCommands.filter(
        (e) => e.id == valid[0].commands![0].customCommandId && e.autoExecute
      );

      if (custom.length > 0) {
        response.execute = valid[0];
      }
    }

    return response;
  }

  clearPending() {
    this.pending = undefined;
  }

/*  audioPlay(tone: string) {
    const filePath = path.join(__dirname, "..", this.fileFolder, this.feedbackFileMap[tone]);
    this.log.debug(`Playing audio from: ${filePath}`);
    console.error(`Playing audio from: ${filePath}`);

    try {
      const audioCtx = new (window.AudioContext)();
      const audioElement = new Audio(filePath);
      const track = audioCtx.createMediaElementSource(audioElement);
      const gainNode = audioCtx.createGain();

      // Connect the audio graph
      track.connect(gainNode).connect(audioCtx.destination);

      // Set the volume
      gainNode.gain.value = 0.5;

      // Check if AudioContext is suspended and resume if necessary
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().then(() => {
          this.log.debug('AudioContext resumed');
          audioElement.play().catch((error) => {
            this.log.error("Audio playback failed after resume:", error);
          });
        });
      } else {
        audioElement.play().catch((error) => {
          this.log.error("Audio playback failed:", error);
        });
      }

    } catch (error) {
      this.log.error("Error in audioPlay function:", error);
    }
  }*/

  audioPlay(tone: string) {
    const filePath = path.join(__dirname, "..", this.fileFolder, this.feedbackFileMap[tone]);
    this.log.debug(`Playing audio from: ${filePath}`);
    console.error(`Playing audio from: ${filePath}`);

    try {
      // Construct the full file path to the audio file
      const filePath = path.join(__dirname, "..", this.fileFolder, this.feedbackFileMap[tone]);

      // Use node-wav-player to play the audio file
      player.play({
        path: filePath
      })
          .then(() => {
            console.log('Audio playback started successfully');
          })
          .catch((error: any) => {
            this.log.error(`Failed to play audio file: ${error}`);
          });

    } catch (e) {
      this.log.error(`An error occurred while trying to play the audio: ${e}`);
    }
  }

  async feedback_play(response: core.ICommandsResponse) {
    // If response.final=True and, ...
    // Response.execute is null, alternative list has no valid commands: FAIL_ALL: https://bit.ly/3Y2ooFC
    // Response.execute is null, alternative list has 1 or more valid commands: FAIL_CHOOSE:
    // Response.execute is {} ad has only one alternative: SUCCESS_HIT: https://bit.ly/3TKLAFy
    // Response.execute is {} and has more than one alternative: SUCCESS_HIT_CHOOSE: https://bit.ly/4eJKFh0
    // Response.execute is {} and command type=57: SUCCESS_CHOOSE: https://bit.ly/4eIE3PG

    if (!response.final) {
      return;
    }

    this.log.debug(`Feedback play 0: ${this.settings.getAudioFeedback()}`);
    if (this.settings.getAudioFeedback() == "silent") {
      return;
    }

    this.log.debug(`Feedback play 1:  ${JSON.stringify(response.execute)}`);
    if (!response.execute) {
      this.log.debug(`Feedback play 2: ${JSON.stringify(response.alternatives)}`);
      if (!response.alternatives || response.alternatives.length == 0) {
        this.log.debug(`Feedback play 3: FAIL_ALL`);
        this.audioPlay("FAIL_ALL");
        return;
      }

      if (response.alternatives) {
        var hasValidCommands = false;
        response.alternatives.forEach((alternative: core.ICommandsResponseAlternative) => {
          if (alternative.commands && alternative.commands.length > 0) {
            alternative.commands.forEach((command: core.ICommand) => {
              if (command.type != core.CommandType.COMMAND_TYPE_INVALID) {
                hasValidCommands = true;
              }
            });
          }
        });

        if (!hasValidCommands) {
            this.log.debug(`Feedback play 4: FAIL_ALL`);
            this.audioPlay("FAIL_ALL");
        } else {
          this.log.debug(`Feedback play 3: FAIL_CHOOSE`);
          this.audioPlay("FAIL_CHOOSE");
        }
        return;
      }
    }

    if (this.settings.getAudioFeedback() == "errorOnly") {
      return;
    }

    this.log.debug(`Feedback play 6: ${JSON.stringify(response.execute?.commands?.length)}`);
    this.log.debug(`Feedback play 7: ${JSON.stringify(response.alternatives?.length)}`);

    if (response.execute && response.execute.commands &&
        response.execute.commands.length >= 1) {
      var alternatives = response.alternatives;
      var commands = response.execute.commands;
      var validAlternatives = 0;
      var validCommands = 0;

      commands?.forEach((command: core.ICommand) => {
          if (command.type != core.CommandType.COMMAND_TYPE_INVALID) {
            validCommands++;
          }
      });

      alternatives?.forEach((alternative: core.ICommandsResponseAlternative) => {
        if (alternative.commands && alternative.commands.length > 0) {
          alternative.commands.forEach((command: core.ICommand) => {
            if (command.type != core.CommandType.COMMAND_TYPE_INVALID) {
              validAlternatives++;
            }
          });
        }
      });

      this.log.debug(`Feedback play 10: ${JSON.stringify(response.execute?.commands)}`);
      this.log.debug(`Feedback play 11: ${JSON.stringify(response.execute?.commands?.length)}`);
      if (response.execute && response.execute.commands &&
        response.execute.commands[0].type == 7) {
        this.log.debug(`Feedback play 12: SUCCESS_CHOOSE`);
        this.audioPlay("SUCCESS_CHOOSE");
        return;
      }

      if (this.settings.getAudioFeedback() == "userRequired") {
        return;
      }

      this.log.debug(`Feedback play 7.5: ${validCommands}`);
      this.log.debug(`Feedback play 7.6: ${validAlternatives}`);

      if (validCommands >= 1 && validAlternatives <= 1) {
        this.log.debug(`Feedback play 8: SUCCESS_HIT`);
        this.audioPlay("SUCCESS_HIT");
        return;
      } else {
        this.log.debug(`Feedback play 9: SUCCESS_HIT_CHOOSE`);
        this.audioPlay("SUCCESS_HIT_CHOOSE");
        return;
      }
    }
  }

  async execute(response: core.ICommandsResponse, updateRenderer: boolean = true) {
    this.lastEndpointId = response.endpointId!;

    // reset the state of the alternatives spinner each time a new command is executed,
    // and if the command needs a spinner, it will set it back below
    this.bridge.setState(
      {
        alternativesSpinner: [],
      },
      [this.mainWindow, this.miniModeWindow]
    );

    this.log.debug(`Executing response: ${JSON.stringify(response)}`);
    await this.feedback_play(response);

    if (updateRenderer) {
      this.showAlternativesIfPresent(response);
    }


    if (response.alternatives && response.alternatives.length > 0) {
      this.nativeCommands.useNeedsUndo = false;
    }

    if (!this.hasExecute(response)) {
      this.resolveChainFinished();
      this.newChainFinishedPromise();
      return;
    } else {
      this.addToHistory(response);
    }

    let forwardToPlugin = true;
    if (
      (this.active.app == "jetbrains" && this.active.filename == "jetbrains-modal") ||
      this.revisionBoxWindow.shown()
    ) {
      forwardToPlugin = false;
    }
    if (
      forwardToPlugin &&
      !this.settings.getNuxCompleted() &&
      response.execute &&
      response.execute.commands
    ) {
      for (const command of response.execute.commands) {
        if (command.type == core.CommandType.COMMAND_TYPE_UNDO) {
          forwardToPlugin = false;
        }
      }
    }

    let pluginResponse;
    if (forwardToPlugin) {
      // try forwarding commands to the active application plugin
      try {
        pluginResponse = await this.pluginManager.sendResponseToApp(this.active.app, response);
      } catch (e) {
        console.log(e);
      }
    }

    // process supported commands with the client's handler directly
    if (response.execute && response.execute.commands) {
      for (const command of response.execute.commands) {
        const commandType = commandTypeToString(command.type!);
        if (commandType in this.commandHandler()) {
          if (
            command.type != core.CommandType.COMMAND_TYPE_DIFF &&
            command.type != core.CommandType.COMMAND_TYPE_INSERT &&
            command.type != core.CommandType.COMMAND_TYPE_RUN
          ) {
            this.insertHistory.clear();
          }

          await this.commandHandler()[commandType](command);
          if (
            command.type == core.CommandType.COMMAND_TYPE_RUN ||
            command.type == core.CommandType.COMMAND_TYPE_PRESS
          ) {
            this.insertHistory.clear();
          }
        }
      }
    }

    if (response.execute && response.execute.remaining) {
      await this.executeChain(response.execute.remaining);
    } else {
      this.handleResponseFromPlugin(pluginResponse);
    }

    this.nux.updateForResponse(response);
  }

  async executePending(index: number) {
    if (this.pending && this.pending.alternatives) {
      const alternative = this.pending.alternatives[index];
      if (alternative) {
        if (this.settings.getLogAudio() || this.settings.getLogSource()) {
          this.api.logEvent("client.stream.resolution", {
            dt: Date.now(),
            data: {
              endpoint_id: this.lastEndpointId,
              resolved_alternative_id: alternative.alternativeId,
              resolved_endpoint_id: this.pending.endpointId,
            },
          });
        }

        await this.execute({ execute: alternative }, false);
        this.bridge.setState(
          {
            highlighted: [index],
          },
          [this.mainWindow, this.miniModeWindow]
        );
      }
    }
  }

  async executeChain(text: string) {
    this.log.debug(`Executing chain: ${text}`);
    await this.stream.sendInitializeRequest();
    this.stream.sendCallbackRequest({
      type: core.CallbackType.CALLBACK_TYPE_CHAIN,
      text,
    });

    await this.chainFinishedPromise;
  }

  async postProcessResponse(response: core.ICommandsResponse) {
    if (!response.alternatives) {
      return response;
    }

    if (os.platform() != "linux") {
      response = await this.invalidateBadApplicationCommands(
        response,
        () => this.system.installedApplications(),
        (command: core.ICommand) => command.type == core.CommandType.COMMAND_TYPE_LAUNCH
      );
    }

    response = await this.invalidateBadApplicationCommands(
      response,
      () => this.system.runningApplications(),
      (command: core.ICommand) =>
        command.type == core.CommandType.COMMAND_TYPE_FOCUS ||
        command.type == core.CommandType.COMMAND_TYPE_QUIT
    );

    response = await this.invalidateBadClickCommands(response);
    response = await this.invalidateBadUseCommands(response);
    response = await this.invalidateMaxKeystrokeCommands(response);
    response = this.removeCommandsForUseOrCancel(response);
    response = this.truncateAlternativesIfNeeded(response);
    response = this.setExecuteToFirstAlternativeIfNeeded(response);
    return response;
  }

  showAlternativesIfPresent(response: core.ICommandsResponse) {
    // don't show alternatives for meta responses, since that would blow away the choices
    if (isMetaResponse(response)) {
      return;
    }

    if (response.alternatives && response.alternatives.length > 0) {
      this.log.debug(
        `Showing alternatives [${response.alternatives.map((e: any) => e.transcript).join(", ")}], num alternatives: ${
          response.alternatives.length}`
      );

      this.bridge.setState(
        {
          alternatives: response.alternatives,
        },
        [this.mainWindow, this.miniModeWindow]
      );

      if (response.final) {
        this.log.debug("Final response, clearing pending");
        this.savePendingResponseIfNeeded(response);
        this.bridge.setState(
          {
            highlighted: this.hasExecute(response) ? [0] : [],
          },
          [this.mainWindow, this.miniModeWindow]
        );
      }
    }

    if (
      (this.settings.getMiniMode() || !this.mainWindow.shown()) &&
      this.settings.getUseMiniModeHideTimeout()
    ) {
      if (this.miniModeHideTimeout) {
        clearTimeout(this.miniModeHideTimeout);
      }

      this.miniModeHideTimeout = global.setTimeout(() => {
        this.bridge.setState(
          {
            alternatives: [],
          },
          [this.mainWindow, this.miniModeWindow]
        );
      }, Math.max(1, 1000 * this.settings.getMiniModeHideTimeout()));
    }

    setTimeout(() => {
      this.bridge.send("updateMiniModeWindowHeight", {}, [this.miniModeWindow]);
    }, 50);
  }

  truncateAlternativesIfNeeded(response: core.ICommandsResponse): core.ICommandsResponse {
    if (
      (this.settings.getMiniMode() || !this.mainWindow.shown()) &&
      this.settings.getUseMiniModeFewerAlternatives()
    ) {
      response.alternatives = (response.alternatives || []).slice(
        0,
        Math.max(1, this.settings.getMiniModeFewerAlternativesCount())
      );
    }

    return response;
  }
}
