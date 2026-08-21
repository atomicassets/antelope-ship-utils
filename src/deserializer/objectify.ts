// The ABI names of the two wharfkit float wrappers that carry a JavaScript
// number. float128 is left out: it holds raw bytes and keeps its hex string.
const NUMERIC_FLOAT_ABI_NAMES = ['float32', 'float64'];

/**
 * True when the value is a wharfkit Float32 or Float64 wrapper.
 *
 * The test reads the shape rather than using instanceof, because a consumer
 * can resolve two copies of @wharfkit/antelope in its node_modules. An
 * instanceof against this package's own copy would miss the wrappers the
 * other copy produced and silently return them as strings.
 */
function isNumericFloat(value: object): boolean {
    // The constructor is read off the prototype rather than off the value, so
    // an own field cannot impersonate a wrapper: an ABI field name is any
    // string, and a decoded struct carrying `constructor` and `value` fields
    // would otherwise collapse to a number.
    //
    // The ABI name is read first and the value second, because `value` is not
    // an inert property on every wharfkit class. Asset exposes it as a getter
    // that throws for a quantity above 53 bits, and Serializer.objectify never
    // reads it, so reading it here on any object would turn a large transfer
    // into a decode failure.
    const prototype = Object.getPrototypeOf(value) as { constructor?: { abiName?: unknown } } | null;
    const ctor = prototype ? prototype.constructor : undefined;

    if (!ctor || typeof ctor.abiName !== 'string' || !NUMERIC_FLOAT_ABI_NAMES.includes(ctor.abiName)) {
        return false;
    }

    return typeof (value as { value?: unknown }).value === 'number';
}

/**
 * Turn a decoded wharfkit value into plain JSON data, as Serializer.objectify
 * does, with one difference: a float32 or float64 wrapper becomes its number
 * instead of the string its toJSON returns.
 *
 * Under @wharfkit/antelope 1.x, Float32.toString is value.toFixed(7), which
 * keeps seven decimal places rather than the seven significant digits a
 * float32 carries. A float32 that needs more than seven fractional decimals to
 * name itself therefore loses information on the way to JSON. Sampling over
 * 20,000 random float32 values per decade found that none failed to round-trip
 * at or above 1, 41% failed in [0.5, 1), 87% failed in [0.1, 0.2), and 99%
 * failed in [0.01, 0.02); every sampled value at or below 0.001 failed to
 * round-trip, while the float32 form of 0.001 itself round-trips. Both
 * indexers persist this result, and their other decode path (serialized bytes
 * through the atomicassets SDK) already yields numbers, so the wrapper stays a
 * number here and the two paths agree. @wharfkit/antelope 2.x instead renders
 * Float32 as the shortest round-trip string of the widened double
 * (wharfkit/antelope commit f70dadd), so under 2.x the numeric walk below is a
 * shape choice rather than a precision repair.
 */
export function objectifyNumericFloats(value: unknown): any {
    const walk = (v: any): any => {
        switch (typeof v) {
            case 'boolean':
            case 'number':
            case 'string':
                return v;
            case 'object': {
                if (v === null) {
                    return v;
                }
                if (isNumericFloat(v)) {
                    return v.value;
                }
                if (typeof v.toJSON === 'function') {
                    return walk(v.toJSON());
                }
                if (Array.isArray(v)) {
                    return v.map(walk);
                }
                const rv: any = {};
                for (const key of Object.keys(v)) {
                    rv[key] = walk(v[key]);
                }
                return rv;
            }
        }

        // Every other typeof falls through the way Serializer.objectify does,
        // which returns undefined for it.
        return undefined;
    };

    return walk(value);
}
