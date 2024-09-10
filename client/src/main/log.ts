import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import Settings from "./settings";
import * as wiston from "winston";

export default class Log {
  private logger: wiston.Logger;
  private label: string;
  private errorStream?: fs.WriteStream;
  private verboseStream?: fs.WriteStream;
  private defaultLevel: string = "info";

  constructor(private settings: Settings, label?: string) {
    if (label) {
          this.label = label;
    } else {
          this.label = "serenade";
    }

    const myFmt = wiston.format.printf(({ level, label, message, timestamp }) => {
      return `${timestamp} [${label}] ${level}: ${message}`;
    });

    this.logger = wiston.createLogger({
      level: this.validateLogLevel(this.settings.getLoggingLevel()),
      format: wiston.format.combine(
        wiston.format.label({ label: this.label }),
        wiston.format.timestamp(),
        myFmt
      ),
      transports: [
        new wiston.transports.Console(),
        new wiston.transports.File({
          filename: path.join(os.homedir(), ".serenade", "serenade.log"),
        }),
      ]
    });
  }

  validateLogLevel(level: string): string {
    if (wiston.config.syslog.levels[level]) {
      return level;
    } else {
      return this.defaultLevel;
    }
  }

  debug(message: string) {
    this.logger.debug(message);
  }

  info(message: string) {
    this.logger.info(message);
  }

  warn(message: string) {
    this.logger.warn(message);
  }

  error(message: string, e?: any) {
    if (e) {
      message = `${message}: ${e.message}`;
      this.logger.error(message);
      this.logger.error(e.stack);
    } else {
      this.logger.error(message);
    }
  }
}
