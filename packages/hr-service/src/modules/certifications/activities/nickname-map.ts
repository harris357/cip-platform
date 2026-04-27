// canonical (lowercase) → common variants (all lowercase)
export const NICKNAME_MAP: Record<string, string[]> = {
  william:     ['will', 'bill', 'billy', 'willy', 'liam'],
  robert:      ['rob', 'bob', 'bobby', 'robbie', 'bert'],
  richard:     ['rick', 'ricky', 'dick', 'richie'],
  james:       ['jim', 'jimmy', 'jamie'],
  thomas:      ['tom', 'tommy'],
  charles:     ['charlie', 'chuck', 'chaz', 'chas'],
  joseph:      ['joe', 'joey'],
  michael:     ['mike', 'mikey', 'mick', 'mickey'],
  daniel:      ['dan', 'danny'],
  david:       ['dave', 'davy'],
  andrew:      ['andy', 'drew'],
  edward:      ['ed', 'eddie', 'ned', 'ted', 'teddy'],
  christopher: ['chris'],
  anthony:     ['tony'],
  timothy:     ['tim', 'timmy'],
  patrick:     ['pat', 'paddy'],
  donald:      ['don', 'donnie'],
  ronald:      ['ron', 'ronnie'],
  kenneth:     ['ken', 'kenny'],
  steven:      ['steve', 'stevie'],
  stephen:     ['steve', 'stevie'],
  matthew:     ['matt', 'matty'],
  lawrence:    ['larry'],
  gerald:      ['jerry'],
  raymond:     ['ray'],
  gregory:     ['greg'],
  samuel:      ['sam', 'sammy'],
  nicholas:    ['nick', 'nicky'],
  benjamin:    ['ben', 'benny'],
  jonathan:    ['jon', 'jonny'],
  alexander:   ['alex', 'al', 'xander'],
  peter:       ['pete'],
  henry:       ['hank', 'hal'],
  george:      ['georgie'],
  john:        ['johnny', 'jack'],
  jeffrey:     ['jeff'],
  brian:       ['bri'],
  margaret:    ['peggy', 'maggie', 'meg', 'peg'],
  elizabeth:   ['liz', 'beth', 'betty', 'eliza', 'libby', 'lisa', 'ellie', 'ella'],
  katherine:   ['kate', 'katie', 'kathy', 'kat', 'kitty'],
  catherine:   ['kate', 'katie', 'cathy', 'kat', 'kitty'],
  patricia:    ['pat', 'patty', 'trish', 'tricia'],
  jennifer:    ['jenny', 'jen'],
  susan:       ['sue', 'susie'],
  barbara:     ['barb', 'barbie'],
  dorothy:     ['dot', 'dottie'],
  linda:       ['lin', 'lindy'],
  sandra:      ['sandy'],
  rebecca:     ['becky', 'becca'],
  deborah:     ['deb', 'debbie'],
  christine:   ['chris', 'tina', 'chrissie'],
  christina:   ['chris', 'tina', 'chrissie'],
  stephanie:   ['steph'],
  jessica:     ['jess', 'jessie'],
  amanda:      ['mandy'],
  kimberly:    ['kim'],
  michelle:    ['shelly', 'shelley'],
  melissa:     ['mel', 'missy'],
  samantha:    ['sam', 'sammy'],
  rachel:      ['rach'],
  carolyn:     ['carol', 'caro'],
  virginia:    ['ginny', 'ginger'],
  jacqueline:  ['jackie', 'jacqui'],
  theodore:    ['theo', 'ted', 'teddy'],
  nathaniel:   ['nate', 'nathan'],
  fredrick:    ['fred', 'freddy'],
  lawrence2:   ['lorry'],
  leonard:     ['len', 'lenny'],
  terrence:    ['terry'],
  arthur:      ['art'],
  albert:      ['al', 'bert'],
  harold:      ['hal', 'harry'],
  walter:      ['walt', 'wally'],
  eugene:      ['gene'],
  lawrence3:   ['laurie'],
  clarence:    ['clar'],
  arnold:      ['arnie'],
};

// Build reverse map: nickname → canonical
const _reverseNickname: Record<string, string> = {};
for (const [canonical, nicknames] of Object.entries(NICKNAME_MAP)) {
  for (const nick of nicknames) {
    if (!(_reverseNickname[nick])) _reverseNickname[nick] = canonical;
  }
}

/** Return all name variants for a given first name (including canonical and all aliases). */
export function nameAliasSet(firstName: string): Set<string> {
  const lower = firstName.toLowerCase();
  const set = new Set<string>([lower]);

  const nicknames = NICKNAME_MAP[lower];
  if (nicknames) for (const n of nicknames) set.add(n);

  const canonical = _reverseNickname[lower];
  if (canonical) {
    set.add(canonical);
    const coNicks = NICKNAME_MAP[canonical];
    if (coNicks) for (const n of coNicks) set.add(n);
  }

  return set;
}
