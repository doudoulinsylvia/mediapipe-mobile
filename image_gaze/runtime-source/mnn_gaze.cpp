// Local single-threaded WebAssembly bridge; MNN is Apache-2.0.
// Model weights retain the upstream GazeFollower CC-BY-NC-SA-4.0 license.
#include <MNN/Interpreter.hpp>
#include <MNN/Tensor.hpp>
#include <cmath>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

namespace {
std::unique_ptr<MNN::Interpreter> net;
MNN::Session* session = nullptr;
std::string last_error;
std::vector<float> result;
constexpr int FACE_VALUES = 224 * 224 * 3;
constexpr int EYE_VALUES = 112 * 112 * 3;
constexpr int OUTPUT_VALUES = 258;

int fail(const std::string& message) {
    last_error = message;
    result.clear();
    return 0;
}

bool finite(const float* values, int count) {
    if (!values) return false;
    for (int i = 0; i < count; ++i) {
        if (!std::isfinite(values[i])) return false;
    }
    return true;
}

bool copy_image(const char* name, const float* values, int side) {
    auto* target = net->getSessionInput(session, name);
    if (!target) return false;
    auto host = std::unique_ptr<MNN::Tensor>(MNN::Tensor::create<float>(
        {1, side, side, 3}, const_cast<float*>(values), MNN::Tensor::TENSORFLOW));
    return target->copyFromHostTensor(host.get());
}
}

extern "C" {
const char* gaze_error() { return last_error.c_str(); }
const char* gaze_runtime_version() { return MNN::getVersion(); }

void gaze_destroy() {
    result.clear();
    session = nullptr;
    net.reset();
    last_error.clear();
}

int gaze_create(const unsigned char* data, int length) {
    gaze_destroy();
    if (!data || length < 1024) return fail("invalid_model_buffer");
    net.reset(MNN::Interpreter::createFromBuffer(data, static_cast<size_t>(length)));
    if (!net) return fail("invalid_mnn_model");
    net->setSessionMode(MNN::Interpreter::Session_Release);
    MNN::BackendConfig backend;
    backend.precision = MNN::BackendConfig::Precision_High;
    MNN::ScheduleConfig config;
    config.type = MNN_FORWARD_CPU;
    config.numThread = 1;
    config.backendConfig = &backend;
    session = net->createSession(config);
    if (!session) return fail("mnn_session_creation_failed");
    const auto inputs = net->getSessionInputAll(session);
    if (inputs.size() != 4) return fail("expected_four_named_inputs");
    for (const char* name : {"face", "left", "right", "rect"}) {
        auto* tensor = net->getSessionInput(session, name);
        if (!tensor) return fail(std::string("missing_input:") + name);
        const int count = std::strcmp(name, "face") == 0 ? FACE_VALUES :
            (std::strcmp(name, "rect") == 0 ? 12 : EYE_VALUES);
        if (tensor->elementSize() != count) return fail(std::string("input_shape_mismatch:") + name);
        auto type = tensor->getType();
        if (type.code != halide_type_float || type.bits != 32) return fail("expected_float32_inputs");
    }
    auto* output = net->getSessionOutput(session, "output_0");
    if (!output || output->elementSize() != OUTPUT_VALUES) return fail("expected_258_output_values");
    return 1;
}

int gaze_run(const float* face, int face_length, const float* left, int left_length,
             const float* right, int right_length, const float* rect, int rect_length) {
    result.clear();
    if (!net || !session) return fail("model_not_initialized");
    if (face_length != FACE_VALUES || left_length != EYE_VALUES ||
        right_length != EYE_VALUES || rect_length != 12) return fail("input_length_mismatch");
    if (!finite(face, face_length) || !finite(left, left_length) ||
        !finite(right, right_length) || !finite(rect, rect_length)) return fail("nonfinite_input");
    if (!copy_image("face", face, 224) || !copy_image("left", left, 112) ||
        !copy_image("right", right, 112)) return fail("input_copy_failed");
    auto* rect_target = net->getSessionInput(session, "rect");
    auto rect_host = std::unique_ptr<MNN::Tensor>(MNN::Tensor::create<float>(
        {1, 12}, const_cast<float*>(rect), MNN::Tensor::CAFFE));
    if (!rect_target->copyFromHostTensor(rect_host.get())) return fail("rect_copy_failed");
    if (net->runSession(session) != MNN::NO_ERROR) return fail("mnn_inference_failed");
    auto* output = net->getSessionOutput(session, "output_0");
    MNN::Tensor output_host(output, MNN::Tensor::CAFFE);
    if (!output->copyToHostTensor(&output_host)) return fail("output_copy_failed");
    if (output_host.elementSize() != OUTPUT_VALUES ||
        !finite(output_host.host<float>(), OUTPUT_VALUES)) return fail("invalid_model_output");
    result.assign(output_host.host<float>(), output_host.host<float>() + OUTPUT_VALUES);
    last_error.clear();
    return OUTPUT_VALUES;
}

const float* gaze_output() { return result.empty() ? nullptr : result.data(); }
}
