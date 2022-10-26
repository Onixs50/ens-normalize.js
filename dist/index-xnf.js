function decode_arithmetic(bytes) {
	let pos = 0;
	function u16() { return (bytes[pos++] << 8) | bytes[pos++]; }
	
	// decode the frequency table
	let symbol_count = u16();
	let total = 1;
	let acc = [0, 1]; // first symbol has frequency 1
	for (let i = 1; i < symbol_count; i++) {
		acc.push(total += u16());
	}

	// skip the sized-payload that the last 3 symbols index into
	let skip = u16();
	let pos_payload = pos;
	pos += skip;

	let read_width = 0;
	let read_buffer = 0; 
	function read_bit() {
		if (read_width == 0) {
			// this will read beyond end of buffer
			// but (undefined|0) => zero pad
			read_buffer = (read_buffer << 8) | bytes[pos++];
			read_width = 8;
		}
		return (read_buffer >> --read_width) & 1;
	}

	const N = 31;
	const FULL = 2**N;
	const HALF = FULL >>> 1;
	const QRTR = HALF >> 1;
	const MASK = FULL - 1;

	// fill register
	let register = 0;
	for (let i = 0; i < N; i++) register = (register << 1) | read_bit();

	let symbols = [];
	let low = 0;
	let range = FULL; // treat like a float
	while (true) {
		let value = Math.floor((((register - low + 1) * total) - 1) / range);
		let start = 0;
		let end = symbol_count;
		while (end - start > 1) { // binary search
			let mid = (start + end) >>> 1;
			if (value < acc[mid]) {
				end = mid;
			} else {
				start = mid;
			}
		}
		if (start == 0) break; // first symbol is end mark
		symbols.push(start);
		let a = low + Math.floor(range * acc[start]   / total);
		let b = low + Math.floor(range * acc[start+1] / total) - 1;
		while (((a ^ b) & HALF) == 0) {
			register = (register << 1) & MASK | read_bit();
			a = (a << 1) & MASK;
			b = (b << 1) & MASK | 1;
		}
		while (a & ~b & QRTR) {
			register = (register & HALF) | ((register << 1) & (MASK >>> 1)) | read_bit();
			a = (a << 1) ^ HALF;
			b = ((b ^ HALF) << 1) | HALF | 1;
		}
		low = a;
		range = 1 + b - a;
	}
	let offset = symbol_count - 4;
	return symbols.map(x => { // index into payload
		switch (x - offset) {
			case 3: return offset + 0x10100 + ((bytes[pos_payload++] << 16) | (bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 2: return offset + 0x100 + ((bytes[pos_payload++] << 8) | bytes[pos_payload++]);
			case 1: return offset + bytes[pos_payload++];
			default: return x - 1;
		}
	});
}	

// returns an iterator which returns the next symbol
function read_payload(v) {
	let pos = 0;
	return () => v[pos++];
}
function read_compressed_payload(s) {	
	return read_payload(decode_arithmetic(unsafe_atob(s)));
}

// unsafe in the sense:
// expected well-formed Base64 w/o padding 
function unsafe_atob(s) {
	let lookup = [];
	[...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'].forEach((c, i) => lookup[c.charCodeAt(0)] = i);
	let n = s.length;
	let ret = new Uint8Array((6 * n) >> 3);
	for (let i = 0, pos = 0, width = 0, carry = 0; i < n; i++) {
		carry = (carry << 6) | lookup[s.charCodeAt(i)];
		width += 6;
		if (width >= 8) {
			ret[pos++] = (carry >> (width -= 8));
		}
	}
	return ret;
}

// eg. [0,1,2,3...] => [0,-1,1,-2,...]
function signed(i) { 
	return (i & 1) ? (~i >> 1) : (i >> 1);
}

function read_counts(n, next) {
	let v = Array(n);
	for (let i = 0; i < n; i++) v[i] = 1 + next();
	return v;
}

function read_ascending(n, next) {
	let v = Array(n);
	for (let i = 0, x = -1; i < n; i++) v[i] = x += 1 + next();
	return v;
}

function read_deltas(n, next) {
	let v = Array(n);
	for (let i = 0, x = 0; i < n; i++) v[i] = x += signed(next());
	return v;
}

// return unsorted? unique array 
function read_member_array(next, lookup) {
	let v = read_ascending(next(), next);
	let n = next();
	let vX = read_ascending(n, next);
	let vN = read_counts(n, next);
	for (let i = 0; i < n; i++) {
		for (let j = 0; j < vN[i]; j++) {
			v.push(vX[i] + j);
		}
	}
	return lookup ? v.map(x => lookup[x]) : v;
}

// returns map of x => ys
function read_mapped(next) {
	let ret = [];
	while (true) {
		let w = next();
		if (w == 0) break;
		ret.push(read_linear_table(w, next));
	}
	while (true) {
		let w = next() - 1;
		if (w < 0) break;
		ret.push(read_replacement_table(w, next));
	}
	return ret.flat();
}

// read until next is falsy
// return array of read values
function read_array_while(next) {
	let v = [];
	while (true) {
		let x = next();
		if (!x) break;
		v.push(x);
	}
	return v;
}

// read w columns of length n
// return as n rows of length w
function read_transposed(n, w, next) {
	let m = Array(n).fill().map(() => []);
	for (let i = 0; i < w; i++) {
		read_deltas(n, next).forEach((x, j) => m[j].push(x));
	}
	return m;
}
 
// returns [[x, ys], [x+dx, ys+dy], [x+2*dx, ys+2*dy], ...]
// where dx/dy = steps, n = run size, w = length of y
function read_linear_table(w, next) {
	let dx = 1 + next();
	let dy = next();
	let vN = read_array_while(next);
	let m = read_transposed(vN.length, 1+w, next);
	return m.flatMap((v, i) => {
		let [x, ...ys] = v;
		return Array(vN[i]).fill().map((_, j) => {
			let j_dy = j * dy;
			return [x + j * dx, ys.map(y => y + j_dy)];
		});
	});
}

// return [[x, ys...], ...]
// where w = length of y
function read_replacement_table(w, next) { 
	let n = 1 + next();
	let m = read_transposed(n, 1+w, next);
	return m.map(v => [v[0], v.slice(1)]);
}

function read_emoji_trie(next) {
	let sorted = read_member_array(next).sort((a, b) => a - b);
	return read();
	function read() {
		let branches = [];
		while (true) {
			let keys = read_member_array(next, sorted);
			if (keys.length == 0) break;
			branches.push({set: new Set(keys), node: read()});
		}
		branches.sort((a, b) => b.set.size - a.set.size); // sort by likelihood
		let temp = next();
		let valid = temp % 3;
		temp = (temp / 3)|0;
		let fe0f = !!(temp & 1);
		temp >>= 1;
		let save = temp == 1;
		let check = temp == 2;
		return {branches, valid, fe0f, save, check};
	}
}

// read a list of non-empty lists
// where 0 is terminal
// [1 0 1 2 0 0] => [[1],[1,2]]
function read_sequences(next) {
	return read_array_while(() => {
		let v = read_array_while(next);
		if (v.length) return v.map(x => x - 1);
	});
}

// created 2022-10-26T03:24:14.045Z
var r = read_compressed_payload('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');
const ORDERED_SCRIPTS = [{"name":"Korean","test":[1],"rest":[0,2]},{"name":"Japanese","test":[3,4],"rest":[0,2]},{"name":"Han","test":[2],"rest":[0]},{"name":"Latin","test":[5],"rest":[0]},{"name":"Cyrillic","test":[6],"rest":[0]},{"name":"Greek","test":[7],"rest":[0]},{"name":"Arabic","test":[8],"rest":[]},{"name":"Devanagari","test":[9],"rest":[]},{"name":"Hebrew","test":[10],"rest":[]},{"name":"Thai","test":[11],"rest":[]}];

function hex_cp(cp) {
	return cp.toString(16).toUpperCase().padStart(2, '0');
}

function quote_cp(cp) {
	return `{${hex_cp(cp)}}`; // raffy convention: like "\u{X}" w/o the "\u"
}

/*
export function explode_cp(s) {
	return [...s].map(c => c.codePointAt(0));
}
*/
function explode_cp(s) { // this is about 2x faster
	let cps = [];
	for (let pos = 0, len = s.length; pos < len; ) {
		let cp = s.codePointAt(pos);
		pos += cp < 0x10000 ? 1 : 2;
		cps.push(cp);
	}
	return cps;
}

function str_from_cps(cps) {
	const chunk = 4096;
	let len = cps.length;
	if (len < chunk) return String.fromCodePoint(...cps);
	let buf = [];
	for (let i = 0; i < len; ) {
		buf.push(String.fromCodePoint(...cps.slice(i, i += chunk)));
	}
	return buf.join('');
}

function compare_arrays(a, b) {
	let {length: n} = a;
	let c = n - b.length;
	for (let i = 0; c == 0 && i < n; i++) c = a[i] - b[i];
	return c;
}

// reverse polyfill

function nf(cps, form) {
	return explode_cp(str_from_cps(cps).normalize(form));
}

function nfc(cps) {
	return nf(cps, 'NFC');
}
function nfd(cps) {
	return nf(cps, 'NFD');
}

const SORTED_VALID = read_member_array(r).sort((a, b) => a - b);
function read_set(lookup) {
	return new Set(read_member_array(r, lookup));
}
function read_valid_subset() {
	return read_set(SORTED_VALID);
}
function read_valid_subsets() {
	return read_array_while(() => { 
		let v = read_valid_subset();
		if (v.size) return v;
	});
}
const VALID = new Set(SORTED_VALID);
const IGNORED = read_set();
const MAPPED = new Map(read_mapped(r));
const CM = read_valid_subset();
const CM_ISOLATED_PH = [];
const CM_WHITELIST = new Map([
	read_array_while(() => {
		let cp = r();
		if (cp) return [cp, read_sequences(r)];
	}),
	read_member_array(r, SORTED_VALID).map(cp => [cp, CM_ISOLATED_PH]),
].flat());
const SCRIPTS = read_valid_subsets(); // [0] is ALL
const ORDERED = ORDERED_SCRIPTS.map(({name, test, rest}) => {
	test = test.map(i => SCRIPTS[i]);
	rest = [test, rest.map(i => SCRIPTS[i])].flat();
	return {name, test, rest, extra: read_valid_subset(), wholes: read_valid_subset()};
});
const RESTRICTED_WHOLES = read_valid_subset();
const RESTRICTED = read_valid_subsets();
const EMOJI_SOLO = read_set();
const EMOJI_ROOT = read_emoji_trie(r);
const NFC_CHECK = read_valid_subset();
const ESCAPE = read_set();
const CM_INVALID = read_set();

const STOP = 0x2E;
const HYPHEN = 0x2D;
const UNDERSCORE = 0x5F;
const FE0F = 0xFE0F;

const COMMON = 'Common';
const STOP_CH = str_from_cps([STOP]);

function check_leading_underscore(cps) {
	let e = cps.lastIndexOf(UNDERSCORE);
	for (let i = e; i > 0; ) {
		if (cps[--i] !== UNDERSCORE) {
			throw new Error(`underscore allowed only at start`);
		}
	}
	return e + 1;
}

function safe_str_from_cps(cps, quoter = quote_cp) {
	let buf = [];
	if (is_printable_mark(cps[0])) buf.push('◌');
	let prev = 0;
	let n = cps.length;
	for (let i = 0; i < n; i++) {
		let cp = cps[i];
		if (should_escape(cp)) {
			buf.push(str_from_cps(cps.slice(prev, i)));
			buf.push(quoter(cp));
			prev = i + 1;
		}
	}
	buf.push(str_from_cps(cps.slice(prev, n)));
	return buf.join('');
}

function check_label_extension(cps) {
	if (cps.length >= 4 && cps[2] === HYPHEN && cps[3] === HYPHEN && cps.every(cp => cp < 0x80)) {
		throw new Error(`invalid label extension`);
	}
}

// check that cp is not touching another cp
// optionally disallow leading/trailing
function check_surrounding(cps, cp, name, no_leading, no_trailing) {
	let last = -1;
	if (cps[0] === cp) {
		if (no_leading) throw new Error(`leading ${name}`);
		last = 0;
	}
	while (true) {
		let i = cps.indexOf(cp, last+1);
		if (i == -1) break;
		if (last == i-1) throw new Error(`adjacent ${name}`);
		last = i;
	}
	if (no_trailing && last == cps.length-1) throw new Error(`trailing ${name}`);
}

/*
// ContextO: MIDDLE DOT
// https://datatracker.ietf.org/doc/html/rfc5892#appendix-A.3
// Between 'l' (U+006C) characters only, used to permit the Catalan character ela geminada to be expressed.
// note: this a lot of effort for 1 character
// 20221020: disabled
function check_middle_dot(cps) {
	let i = 0;
	while (true) {
		i = cps.indexOf(0xB7, i);
		if (i == -1) break;
		if (cps[i-1] !== 0x6C || cps[i+1] !== 0x6C) throw new Error('ContextO: middle dot');
		i += 2;
	}
}
*/

function check_scripts(cps) {
	for (let {name, test, rest, extra, wholes} of ORDERED) {
		if (cps.some(cp => test.some(set => set.has(cp)))) {
			// https://www.unicode.org/reports/tr39/#mixed_script_confusables
			let bad = cps.find(cp => !rest.some(set => set.has(cp)) && !extra.has(cp)); // should just show first char
			if (bad >= 0) {
				throw new Error(`mixed-script ${name} confusable: "${str_from_cps([bad])}"`);
			}
			// https://www.unicode.org/reports/tr39/#def_whole_script_confusables
			if (cps.every(cp => wholes.has(cp) || SCRIPTS[0].has(cp))) {
				throw new Error(`whole-script ${name} confusable`);
			}
			return name;
		}
	}
	return COMMON;
}

// requires decomposed codepoints
// returns true if pure (emoji or single script)
function check_restricted_scripts(cps) {
	// https://www.unicode.org/reports/tr31/#Table_Candidate_Characters_for_Exclusion_from_Identifiers
	cps = cps.filter(cp => cp != FE0F); // remove emoji (once)
	if (!cps.length) return true; // purely emoji
	for (let set of RESTRICTED) {
		if (cps.some(cp => set.has(cp))) { // first with one match
			if (!cps.every(cp => set.has(cp))) { // must match all
				throw new Error(`restricted script cannot mix`);
			}
			if (cps.every(cp => RESTRICTED_WHOLES.has(cp))) {
				throw new Error(`restricted whole-script confusable`);
			}
			return true;
		}
	}
}


function check_leading_combining_mark(cps) {
	if (CM.has(cps[0])) throw new Error(`leading combining mark`);
}
// requires decomposed codepoints
function check_combining_marks(cps) {
	for (let i = 1, j = -1; i < cps.length; i++) {
		if (CM.has(cps[i])) {
			let prev = cps[i - 1];
			if (prev == FE0F) {
				throw new Error(`emoji + combining mark`); // we dont know the full emoji length efficiently 
			}
			let seqs = CM_WHITELIST.get(prev);
			if (seqs) {
				let k = i + 1;
				while (k < cps.length && CM.has(cps[k])) k++;
				let cms = cps.slice(i, k);
				let match = seqs.find(seq => !compare_arrays(seq, cms));
				if (!match) {
					throw new Error(`disallowed combining mark sequence: "${str_from_cps(cps.slice(i-1, k))}"`)
				}
				i = k; 
			} else if (i == j) { 
				// this needs to come after whitelist test since it can permit 2+
				throw new Error(`adjacent combining marks "${str_from_cps(cps.slice(i-2, i+1))}"`);
			} else {
				j = i + 1;
			}
		}
	}
}

function is_printable_mark(cp) {
	return CM.has(cp) || CM_INVALID.has(cp);
}

function should_escape(cp) {
	return ESCAPE.has(cp);
}

function ens_normalize_fragment(frag, nf = nfc) {
	return frag.split(STOP_CH).map(label => str_from_cps(nf(process(explode_cp(label))))).join(STOP_CH);
}

function ens_normalize(name) {
	return flatten(ens_split(name));
}

function ens_beautify(name) {
	return flatten(ens_split(name, x => x));
}

function ens_split(name, emoji_filter = filter_fe0f) {
	let offset = 0;
	return name.split(STOP_CH).map(label => {
		let input = explode_cp(label);
		let info = {
			input,
			offset, // codepoint not string!
		};
		offset += input.length + 1;
		try {
			let mapped = info.mapped = process(input);
			let norm = info.output = nfc(mapped.flatMap(x => Array.isArray(x) ? emoji_filter(x) : x)); // strip FE0F from emoji
			info.emoji = mapped.some(x => Array.isArray(x)); // idea: count emoji? mapped.reduce((a, x) => a + (Array.isArray(x)?1:0), 0);
			check_leading_underscore(norm); // should restricted get underscores? (20221018: no)
			check_leading_combining_mark(norm);
			check_label_extension(norm);
			let decomp = nfd(mapped.map(x => Array.isArray(x) ? FE0F : x)); // replace emoji with single character placeholder
			if (check_restricted_scripts(decomp)) {
				info.script = mapped.every(x => Array.isArray(x)) ? COMMON : 'Restricted';
			} else {
				check_combining_marks(decomp);
				check_surrounding(norm, 0x2019, 'apostrophe', true, true); // question: can this be generalized better?
				//check_middle_dot(norm);
				info.script = check_scripts(nfc(mapped.flatMap(x => Array.isArray(x) ? [] : x))); // remove emoji
			}
		} catch (err) {
			info.error = err.message;
		}
		return info;
	});
}

// throw on first error
function flatten(split) {
	return split.map(({input, error, output}) => {
		// don't print label again if just a single label
		if (error) throw new Error(split.length == 1 ? error : `Invalid label "${safe_str_from_cps(input)}": ${error}`);
		return str_from_cps(output);
	}).join(STOP_CH);
}

function process(input) {
	let ret = []; 
	input = input.slice().reverse(); // flip so we can pop
	while (input.length) {
		let emoji = consume_emoji_reversed(input);
		if (emoji) {
			ret.push(emoji);
		} else {
			let cp = input.pop();
			if (VALID.has(cp)) {
				ret.push(cp);
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					ret.push(...cps);
				} else if (!IGNORED.has(cp)) {
					let form = should_escape(cp) ? '' : ` "${safe_str_from_cps([cp])}"`;
					throw new Error(`disallowed character:${form} ${quote_cp(cp)}`); 
				}
			}
		}
	}
	return ret;
}

function filter_fe0f(cps) {
	return cps.filter(cp => cp != FE0F);
}

function consume_emoji_reversed(cps, eaten) {
	let node = EMOJI_ROOT;
	let emoji;
	let saved;
	let stack = [];
	let pos = cps.length;
	if (eaten) eaten.length = 0; // clear input buffer (if needed)
	while (pos) {
		let cp = cps[--pos];
		let br = node.branches.find(x => x.set.has(cp));
		if (!br) break;
		node = br.node;
		if (node.save) { // remember
			saved = cp;
		} else if (node.check) { // check exclusion
			if (cp === saved) break;
		}
		stack.push(cp);
		if (node.fe0f) {
			stack.push(FE0F);
			if (pos > 0 && cps[pos - 1] == FE0F) pos--; // consume optional FE0F
		}
		if (node.valid) { // this is a valid emoji (so far)
			emoji = conform_emoji_copy(stack, node);
			if (eaten) eaten.push(...cps.slice(pos).reverse()); // copy input (if needed)
			cps.length = pos; // truncate
		}
	}
	if (!emoji) {
		let cp = cps[cps.length-1];
		if (EMOJI_SOLO.has(cp)) {
			if (eaten) eaten.push(cp);
			emoji = [cp];
			cps.pop();
		}
	}
	return emoji;
}

// create a copy and fix any unicode quirks
function conform_emoji_copy(cps, node) {
	let copy = cps.slice(); // copy stack
	if (node.valid == 2) copy.splice(1, 1); // delete FE0F at position 1 (see: make.js)
	return copy;
}

// return all supported emoji
function ens_emoji() {
	let ret = [...EMOJI_SOLO].map(x => [x]);
	build(EMOJI_ROOT, []);
	return ret.sort(compare_arrays);
	function build(node, cps, saved) {
		if (node.save) { // remember
			saved = cps[cps.length-1];
		} else if (node.check) { // check exclusion
			if (saved === cps[cps.length-1]) return;
		}
		if (node.fe0f) cps.push(FE0F);
		if (node.valid) ret.push(conform_emoji_copy(cps, node));
		for (let br of node.branches) {
			for (let cp of br.set) {
				build(br.node, [...cps, cp], saved);
			}
		}
	}
}

// ************************************************************
// tokenizer 

const TY_VALID = 'valid';
const TY_MAPPED = 'mapped';
const TY_IGNORED = 'ignored';
const TY_DISALLOWED = 'disallowed';
const TY_EMOJI = 'emoji';
const TY_NFC = 'nfc';
const TY_STOP = 'stop';

function ens_tokenize(name, {
	nf = true, // collapse unnormalized runs into a single token
} = {}) {
	let input = explode_cp(name).reverse();
	let eaten = [];
	let tokens = [];
	while (input.length) {		
		let emoji = consume_emoji_reversed(input, eaten);
		if (emoji) {
			tokens.push({type: TY_EMOJI, emoji, input: eaten.slice(), cps: filter_fe0f(emoji)});
		} else {
			let cp = input.pop();
			if (cp === STOP) {
				tokens.push({type: TY_STOP, cp});
			} else if (VALID.has(cp)) {
				/*
				if (CM_WHITELIST.get(cp) === CM_ISOLATED_PH) {
					tokens.push({type: TY_ISOLATED, cp});
				} else {
					tokens.push({type: TY_VALID, cps: [cp]});
				}
				*/
				tokens.push({type: TY_VALID, cps: [cp]});
			} else if (IGNORED.has(cp)) {
				tokens.push({type: TY_IGNORED, cp});
			} else {
				let cps = MAPPED.get(cp);
				if (cps) {
					tokens.push({type: TY_MAPPED, cp, cps: cps.slice()});
				} else {
					tokens.push({type: TY_DISALLOWED, cp});
				}
			}
		}
	}
	if (nf) {
		for (let i = 0, start = -1; i < tokens.length; i++) {
			let token = tokens[i];
			if (is_valid_or_mapped(token.type)) {
				if (requires_check(token.cps)) { // normalization might be needed
					let end = i + 1;
					for (let pos = end; pos < tokens.length; pos++) { // find adjacent text
						let {type, cps} = tokens[pos];
						if (is_valid_or_mapped(type)) {
							if (!requires_check(cps)) break;
							end = pos + 1;
						} else if (type !== TY_IGNORED) { // || type !== TY_DISALLOWED) { 
							break;
						}
					}
					if (start < 0) start = i;
					let slice = tokens.slice(start, end);
					let cps0 = slice.flatMap(x => is_valid_or_mapped(x.type) ? x.cps : []); // strip junk tokens
					let cps = nfc(cps0);
					if (compare_arrays(cps, cps0)) { // bundle into an nfc token
						tokens.splice(start, end - start, {type: TY_NFC, input: cps0, cps, tokens: collapse_valid_tokens(slice)});
						i = start;
					} else { 
						i = end - 1; // skip to end of slice
					}
					start = -1; // reset
				} else {
					start = i; // remember last
				}
			} else if (token.type === TY_EMOJI) { // 20221024: is this correct?
				start = -1; // reset
			}
		}
	}
	return collapse_valid_tokens(tokens);
}

function is_valid_or_mapped(type) {
	return type === TY_VALID || type === TY_MAPPED;
}

function requires_check(cps) {
	return cps.some(cp => NFC_CHECK.has(cp));
}

function collapse_valid_tokens(tokens) {
	for (let i = 0; i < tokens.length; i++) {
		if (tokens[i].type === TY_VALID) {
			let j = i + 1;
			while (j < tokens.length && tokens[j].type === TY_VALID) j++;
			tokens.splice(i, j - i, {type: TY_VALID, cps: tokens.slice(i, j).flatMap(x => x.cps)});
		}
	}
	return tokens;
}

export { ens_beautify, ens_emoji, ens_normalize, ens_normalize_fragment, ens_split, ens_tokenize, is_printable_mark, nfc, nfd, safe_str_from_cps, should_escape };
