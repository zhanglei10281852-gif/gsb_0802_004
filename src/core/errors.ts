export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ProposalNotFoundError extends DomainError {
  constructor(id: string) {
    super(`proposal not found: ${id}`, 'PROPOSAL_NOT_FOUND', 404);
  }
}

export class ProposalAlreadyDecidedError extends DomainError {
  constructor(id: string) {
    super(`proposal already decided: ${id}`, 'PROPOSAL_ALREADY_DECIDED', 409);
  }
}

export class GateBlockedError extends DomainError {
  constructor(message: string, readonly blockers: { code: string; message: string }[]) {
    super(message, 'GATE_BLOCKED', 409);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 422);
  }
}
