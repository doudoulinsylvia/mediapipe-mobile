#!/usr/bin/env python3
"""Read actual MNN contracts and produce deterministic FP32 parity fixtures.

This verifies runtime numerical behavior, not gaze accuracy on participants.
"""
import hashlib
import json
from pathlib import Path
import statistics
import time
import MNN
import numpy as np

ROOT = Path(__file__).resolve().parent
SHAPES = {'face': (1, 224, 224, 3), 'left': (1, 112, 112, 3),
          'right': (1, 112, 112, 3), 'rect': (1, 12)}


def fixture(case):
    tensors = {}
    for index, (name, shape) in enumerate(SHAPES.items()):
        count = int(np.prod(shape))
        if name == 'rect':
            values = np.array([.6, .8, .2, .1, .12, .12, .32, .32,
                               .12, .12, .56, .32], dtype=np.float32)
            if case == 'shifted_rect':
                values[[2, 6, 10]] += np.float32(.03)
        elif case == 'flat':
            values = np.full(count, .5, dtype=np.float32)
        else:
            values = (((np.arange(count, dtype=np.int64) * 17 + index * 31) % 251) / 250).astype(np.float32)
        tensors[name] = values.reshape(shape)
    return tensors


def main():
    report = {'purpose': 'runtime_numeric_parity_only_not_eye_tracking_accuracy',
              'reference': 'MNN Python Module API (matches author), CPU, 1 thread, precision=high',
              'fixtures': {}, 'models': {}}
    for case in ['flat', 'pattern', 'shifted_rect']:
        report['fixtures'][case] = {'input_sha256': {name: hashlib.sha256(values.tobytes()).hexdigest()
            for name, values in fixture(case).items()}}
    for name in ['base', 'mobilenet_v4']:
        path = ROOT / 'upstream/gazefollower/res/model_weights' / (name + '.mnn')
        interpreter = MNN.Interpreter(str(path))
        session = interpreter.createSession({'backend': 'CPU', 'numThread': 1, 'precision': 'high'})
        inputs = interpreter.getSessionInputAll(session)
        outputs = interpreter.getSessionOutputAll(session)
        record = {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                  'inputs': {key: list(tensor.getShape()) for key, tensor in inputs.items()},
                  'outputs': {key: list(tensor.getShape()) for key, tensor in outputs.items()}, 'cases': {}}
        runtime = MNN.nn.create_runtime_manager(({'backend': 0, 'numThread': 1, 'precision': 'high'},))
        module = MNN.nn.load_module_from_file(str(path), ['face', 'left', 'right', 'rect'],
                                             ['output_0'], runtime_manager=runtime)
        for case in ['flat', 'pattern', 'shifted_rect']:
            variables = []
            for key, array in fixture(case).items():
                dimension = MNN.expr.NCHW if key == 'rect' else MNN.expr.NHWC
                variable = MNN.expr.placeholder(array.shape, dimension)
                variable.write(array)
                variables.append(variable)
            timings = []
            for _ in range(6):
                start = time.perf_counter()
                values = np.asarray(module.onForward(variables)[0].read(), dtype=np.float32).reshape(-1).copy()
                timings.append((time.perf_counter() - start) * 1000)
            if values.shape != (258,) or not np.isfinite(values).all():
                raise RuntimeError(f'{name}/{case} returned invalid output: {values.shape}')
            record['cases'][case] = {'native_median_ms': statistics.median(timings[1:]),
                                     'output': values.tolist()}
        report['models'][name] = record
    (ROOT / 'model-inspection.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({name: {key: value for key, value in record.items() if key != 'cases'} |
                       {'native_median_ms': record['cases']['pattern']['native_median_ms']}
                      for name, record in report['models'].items()}, indent=2))


if __name__ == '__main__':
    main()
