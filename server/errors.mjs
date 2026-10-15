export class XPosterError extends Error {
  constructor(code, message, { hint, ...details } = {}) {
    super(message);
    this.name = 'XPosterError';
    this.code = code;
    this.hint = hint;
    this.details = details;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint === undefined ? {} : { hint: this.hint }),
      ...this.details,
    };
  }
}
