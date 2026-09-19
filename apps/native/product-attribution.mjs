/** Validate the public release credits owned by the root package.json.
 * These credits do not change users' local Git commit identities or accounts.
 */
export function packageAttribution(value) {
  const line = (text, label) => {
    if (typeof text !== 'string' || text !== text.trim() || !text || text.length > 512 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(text)) {
      throw Error(`Invalid release attribution ${label}.`);
    }
    return text;
  };
  const website = (text, label) => {
    line(text, label);
    let url;
    try { url = new URL(text); } catch { throw Error(`Invalid release attribution ${label}.`); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || /\s/u.test(text)) throw Error(`Invalid release attribution ${label}.`);
    return text;
  };
  const name = line(value?.author?.name, 'author name');
  const email = line(value?.author?.email, 'author email');
  if (/[<>]/u.test(name) || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(email)) throw Error('Invalid release attribution maintainer.');
  const author = Object.freeze({name, email, url: website(value?.author?.url, 'author URL')});
  const organization = Object.freeze({name: line(value?.organization?.name, 'affiliation'), url: website(value?.organization?.url, 'affiliation URL')});
  return Object.freeze({author, organization, homepage: website(value?.homepage, 'homepage'), copyright: line(value?.copyright, 'copyright')});
}
