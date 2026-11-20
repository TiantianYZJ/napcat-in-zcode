export class OneBotError extends Error {
  constructor(
    public retcode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OneBotError';
  }
}
