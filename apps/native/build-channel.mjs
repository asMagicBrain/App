const configurations = Object.freeze({
  development: Object.freeze({channel: 'development', presentation: 'full-with-grey', canToggleUnavailable: true, validationOnly: false}),
  preview: Object.freeze({channel: 'preview', presentation: 'implemented-only', canToggleUnavailable: false, validationOnly: false}),
});

export function buildConfiguration(channel = 'development') {
  if (typeof channel !== 'string' || !Object.hasOwn(configurations, channel)) throw Error('Unknown native build channel. Use development or preview.');
  return configurations[channel];
}

/** A packaged channel is sealed into its metadata, never selected by the renderer or launch arguments. */
export function resolveBuildConfiguration({args = [], packaged = false, metadata = null} = {}) {
  const choices = args.filter(arg => arg === '--channel' || arg.startsWith('--channel='));
  if (choices.length > 1 || choices[0] === '--channel') throw Error('Use one --channel=development or --channel=preview argument.');
  if (packaged) {
    if (choices.length) throw Error('A packaged application cannot override its build channel.');
    if (metadata?.schemaVersion !== 1 || !Object.hasOwn(metadata, 'channel')) throw Error('Packaged build channel metadata is required.');
    return buildConfiguration(metadata.channel);
  }
  return buildConfiguration(choices.length ? choices[0].slice('--channel='.length) : 'development');
}

export function packageOptions(args) {
  if (args.some(arg => arg !== '--candidate' && !arg.startsWith('--channel=')) || args.filter(arg => arg === '--candidate').length > 1) {
    throw Error('Use package.mjs [--candidate] [--channel=development|preview].');
  }
  const configuration = resolveBuildConfiguration({args});
  const candidate = args.includes('--candidate');
  return {candidate, configuration};
}

export function packageIdentity({channel, bundleId}) {
  buildConfiguration(channel);
  return channel === 'development'
    ? {bundleId, productName: 'asMagicBrain', packageName: 'asmagicbrain'}
    : {bundleId: 'org.asmagicbrain.app.preview', productName: 'asMagicBrain Preview', packageName: 'asmagicbrain-preview'};
}

export function packageOutputName({version, channel, candidate, id}) {
  buildConfiguration(channel);
  return candidate ? `${version}-${channel}-candidate-${id}` : channel === 'preview' ? `${version}-preview` : version;
}
