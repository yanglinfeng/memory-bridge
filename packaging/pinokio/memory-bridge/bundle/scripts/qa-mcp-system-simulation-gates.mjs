export function compareExpectedErrorEvidence(left, right) {
  const leftObserved = left?.observed === true;
  const rightObserved = right?.observed === true;
  const leftFingerprint = typeof left?.fingerprint === 'string'
    ? left.fingerprint
    : '';
  const rightFingerprint = typeof right?.fingerprint === 'string'
    ? right.fingerprint
    : '';
  const fingerprintsPresent =
    /^[0-9a-f]{64}$/u.test(leftFingerprint) &&
    /^[0-9a-f]{64}$/u.test(rightFingerprint);
  const fingerprintsEqual =
    fingerprintsPresent && leftFingerprint === rightFingerprint;
  const leftHasCode = typeof left?.errorCode === 'string' && left.errorCode.length > 0;
  const rightHasCode = typeof right?.errorCode === 'string' && right.errorCode.length > 0;
  const codePresenceEqual = leftHasCode === rightHasCode;
  const codesEqual = !leftHasCode || left.errorCode === right.errorCode;

  return {
    passed:
      leftObserved &&
      rightObserved &&
      fingerprintsEqual &&
      codePresenceEqual &&
      codesEqual,
    leftObserved,
    rightObserved,
    fingerprintsPresent,
    fingerprintsEqual,
    codePresenceEqual,
    codesEqual,
    errorCode: leftHasCode && rightHasCode ? left.errorCode : null,
    evidence: leftHasCode && rightHasCode
      ? 'stable-code-and-message-sha256'
      : 'message-sha256-fallback',
    limitation: leftHasCode && rightHasCode
      ? null
      : 'SDK 未提供双边稳定 errorCode；消息指纹只能证明本次运行响应不可区分，不能保证跨版本错误分类稳定。',
  };
}
