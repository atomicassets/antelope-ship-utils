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
 * Float32.toString is value.toFixed(7), which keeps seven decimal places
 * rather than the seven significant digits a float32 carries. A float32 that
 * needs more than seven fractional decimals to name itself therefore loses
 * information on the way to JSON, which is most of the range below 1 and all
 * of it below 0.001. Both indexers persist this
 * result, and their other decode path (serialized bytes through the
 * atomicassets SDK) already yields numbers, so the wrapper stays a number here
 * and the two paths agree.
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
