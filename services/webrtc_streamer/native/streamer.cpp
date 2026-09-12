// SPDX-License-Identifier: Apache-2.0
#include <rclcpp/rclcpp.hpp>
#include <sensor_msgs/msg/image.hpp>
#include <sensor_msgs/msg/compressed_image.hpp>
#include <opencv2/imgcodecs.hpp>
#include <opencv2/imgproc.hpp>
#include <turbojpeg.h>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libswscale/swscale.h>
}
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <deque>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using Image = sensor_msgs::msg::Image;
using Compressed = sensor_msgs::msg::CompressedImage;
double now_s() {
  return std::chrono::duration<double>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
void avcheck(int result) {
  if (result < 0) { char text[256]; av_strerror(result, text, sizeof(text)); throw std::runtime_error(text); }
}
cv::Size output_size(int width,int height,int max_width,int max_height) {
  double scale=1;
  if (max_width) scale=std::min(scale,static_cast<double>(max_width)/width);
  if (max_height) scale=std::min(scale,static_cast<double>(max_height)/height);
  return {std::max(2,static_cast<int>(width*scale)) & ~1,
          std::max(2,static_cast<int>(height*scale)) & ~1};
}
cv::Mat decode_preview(const std::vector<uint8_t> &data,int max_width,int max_height,cv::Size &target) {
  int flags=cv::IMREAD_COLOR;
  // Only JPEG has reduced-resolution DCT decoding. Leave PNG and EXIF-bearing
  // images on the existing path so OpenCV retains orientation semantics.
  const uint8_t exif[]={'E','x','i','f',0,0};
  if (data.size()>2 && data[0]==0xff && data[1]==0xd8 &&
      std::search(data.begin(),data.end(),std::begin(exif),std::end(exif))==data.end()) {
    tjhandle header=tjInitDecompress();
    if (!header) throw std::runtime_error("JPEG header decoder allocation failed");
    int w=0,h=0,sub=0,color=0;
    int result=tjDecompressHeader3(header,data.data(),data.size(),&w,&h,&sub,&color);
    tjDestroy(header);
    if (result<0 || w<=0 || h<=0) throw std::runtime_error("invalid JPEG header");
    target=output_size(w,h,max_width,max_height);
    for (int factor: {8,4,2}) {
      if ((w+factor-1)/factor>=target.width && (h+factor-1)/factor>=target.height) {
        flags=factor==8?cv::IMREAD_REDUCED_COLOR_8:
              factor==4?cv::IMREAD_REDUCED_COLOR_4:cv::IMREAD_REDUCED_COLOR_2;
        break;
      }
    }
  }
  return cv::imdecode(data,flags);
}
struct Engine {
  int max_width, max_height, fps, current_bitrate = 0;
  std::string topic;
  std::shared_ptr<rclcpp::Context> context;
  rclcpp::Node::SharedPtr node;
  std::shared_ptr<rclcpp::executors::SingleThreadedExecutor> executor;
  rclcpp::SubscriptionBase::SharedPtr subscription;
  rclcpp::TimerBase::SharedPtr discovery;
  std::thread thread;
  std::atomic<bool> stopping{false};
  std::mutex mutex;
  Image::ConstSharedPtr raw;
  Compressed::ConstSharedPtr compressed;
  std::deque<double> arrivals;
  std::string failure;
  uint64_t received = 0;
  std::atomic<uint64_t> decoded{0}, encoded{0}, errors{0};
  cv::Mat last;
  AVCodecContext *codec = nullptr;
  AVFrame *frame = nullptr;
  SwsContext *scaler = nullptr;
  std::vector<uint8_t> output;
  double epoch = now_s(), last_encode = -1;
  int64_t pts = 0;
  bool key = false;
  Engine(std::string t, int w, int h, int f):max_width(w),max_height(h),fps(f),topic(std::move(t)) {
    if (topic.empty() || f < 1 || f > 60 || w < 0 || h < 0) throw std::invalid_argument("invalid native stream options");
  }
  void tick() {
    auto t = now_s(); ++received; arrivals.push_back(t);
    while (!arrivals.empty() && arrivals.front() < t-2) arrivals.pop_front();
  }
  void discover() {
    if (subscription) return;
    auto graph = node->get_topic_names_and_types();
    auto found = graph.find(topic);
    if (found == graph.end()) return;
    auto qos = rclcpp::QoS(rclcpp::KeepLast(1)).best_effort().durability_volatile();
    for (const auto &type: found->second) {
      if (type == "sensor_msgs/msg/CompressedImage") {
        subscription = node->create_subscription<Compressed>(topic,qos,[this](Compressed::ConstSharedPtr msg) {
          std::lock_guard<std::mutex> lock(mutex); compressed=std::move(msg); raw.reset(); tick();
        }); return;
      }
      if (type == "sensor_msgs/msg/Image") {
        subscription = node->create_subscription<Image>(topic,qos,[this](Image::ConstSharedPtr msg) {
          std::lock_guard<std::mutex> lock(mutex); raw=std::move(msg); compressed.reset(); tick();
        }); return;
      }
    }
    throw std::runtime_error("native preview requires Image or CompressedImage");
  }
  void start() {
    context=std::make_shared<rclcpp::Context>(); context->init(0,nullptr);
    node=std::make_shared<rclcpp::Node>("webrtc_streamer_native",rclcpp::NodeOptions().context(context));
    rclcpp::ExecutorOptions opts; opts.context=context;
    executor=std::make_shared<rclcpp::executors::SingleThreadedExecutor>(opts);
    discovery=node->create_wall_timer(std::chrono::milliseconds(250),[this]{discover();});
    executor->add_node(node);
    thread=std::thread([this] {
      try { while (!stopping && context->is_valid()) executor->spin_once(std::chrono::milliseconds(100)); }
      catch (const std::exception &e) { std::lock_guard<std::mutex> lock(mutex); failure=e.what(); }
      catch (...) { std::lock_guard<std::mutex> lock(mutex); failure="native executor failed"; }
    });
  }
  void reset_codec() {
    avcodec_free_context(&codec); av_frame_free(&frame);
    sws_freeContext(scaler); scaler=nullptr;
  }
  ~Engine() {
    stopping=true;
    // Bounded spin_once guarantees join even if cancel fails.
    try { if (executor) executor->cancel(); }
    catch (...) { std::fprintf(stderr,"native preview executor cancel failed; joining bounded spin\n"); }
    if (thread.joinable()) thread.join();
    subscription.reset(); discovery.reset(); executor.reset(); node.reset();
    try { if (context) context->shutdown("native preview stop"); }
    catch (...) { std::fprintf(stderr,"native preview context shutdown failed\n"); }
    reset_codec();
  }
  void prepare() {
    Image::ConstSharedPtr r; Compressed::ConstSharedPtr c;
    {
      std::lock_guard<std::mutex> lock(mutex);
      if (!failure.empty()) throw std::runtime_error(failure);
      r=std::move(raw); c=std::move(compressed);
    }
    if (!r && !c) return;
    try {
      cv::Mat bgr;
      cv::Size target;
      if (c) bgr=decode_preview(c->data,max_width,max_height,target);
      else {
        int channels;
        if (r->encoding=="bgr8" || r->encoding=="rgb8") channels=3;
        else if (r->encoding=="mono8" || r->encoding=="8UC1") channels=1;
        else if (r->encoding=="bgra8" || r->encoding=="rgba8") channels=4;
        else throw std::runtime_error("native raw preview supports 8-bit RGB/BGR/RGBA/BGRA/mono only");
        if (!r->width || !r->height || r->width>16384 || r->height>16384 ||
            r->step < r->width*channels || r->data.size()<static_cast<size_t>(r->step)*r->height)
          throw std::runtime_error("invalid raw image dimensions/stride");
        cv::Mat view(r->height,r->width,CV_MAKETYPE(CV_8U,channels),const_cast<uint8_t*>(r->data.data()),r->step);
        if (r->encoding=="rgb8") cv::cvtColor(view,bgr,cv::COLOR_RGB2BGR);
        else if (r->encoding=="rgba8") cv::cvtColor(view,bgr,cv::COLOR_RGBA2BGR);
        else if (r->encoding=="bgra8") cv::cvtColor(view,bgr,cv::COLOR_BGRA2BGR);
        else if (channels==1) cv::cvtColor(view,bgr,cv::COLOR_GRAY2BGR);
        // The ROS message owns this view until prepare() returns. Resizing
        // reads it directly; only an unscaled retained frame needs a copy.
        else bgr=view;
      }
      if (bgr.empty()) throw std::runtime_error("invalid compressed preview image");
      if (target.empty()) target=output_size(bgr.cols,bgr.rows,max_width,max_height);
      int w=target.width, h=target.height;
      if (w!=bgr.cols || h!=bgr.rows) cv::resize(bgr,last,cv::Size(w,h),0,0,cv::INTER_AREA);
      else if (r && r->encoding=="bgr8") last=bgr.clone();
      else last=bgr;
      ++decoded;
    } catch (const std::exception &e) {
      ++errors; std::fprintf(stderr,"native preview conversion failed: %s\n",e.what());
      // Preserve the last valid frame, matching the Python backend.
    }
  }
  void open_codec(int bitrate) {
    reset_codec();
    const AVCodec *impl=avcodec_find_encoder_by_name("libvpx");
    if (!impl) throw std::runtime_error("libvpx encoder missing");
    codec=avcodec_alloc_context3(impl); if (!codec) throw std::bad_alloc();
    codec->width=last.cols; codec->height=last.rows; codec->pix_fmt=AV_PIX_FMT_YUV420P;
    codec->time_base=AVRational{1,90000}; codec->framerate=AVRational{fps,1};
    codec->bit_rate=bitrate; codec->rc_min_rate=bitrate; codec->rc_max_rate=bitrate;
    codec->rc_buffer_size=bitrate; codec->qmin=2; codec->qmax=56; codec->gop_size=3000;
    codec->thread_count=1;
    AVDictionary *options=nullptr;
    av_dict_set(&options,"cpu-used","-6",0); av_dict_set(&options,"deadline","realtime",0);
    av_dict_set(&options,"lag-in-frames","0",0); av_dict_set(&options,"noise-sensitivity","4",0);
    av_dict_set(&options,"overshoot-pct","15",0); av_dict_set(&options,"undershoot-pct","100",0);
    av_dict_set(&options,"partitions","0",0); av_dict_set(&options,"static-thresh","1",0);
    int result=avcodec_open2(codec,impl,&options); av_dict_free(&options); avcheck(result);
    frame=av_frame_alloc(); if (!frame) throw std::bad_alloc();
    frame->width=codec->width; frame->height=codec->height; frame->format=codec->pix_fmt;
    avcheck(av_frame_get_buffer(frame,32));
    scaler=sws_getContext(last.cols,last.rows,AV_PIX_FMT_BGR24,last.cols,last.rows,AV_PIX_FMT_YUV420P,SWS_BICUBIC,nullptr,nullptr,nullptr);
    if (!scaler) throw std::runtime_error("native color converter missing");
    current_bitrate=bitrate;
  }
  bool next(bool force_keyframe,int bitrate) {
    output.clear(); prepare();
    double t=now_s();
    if (last.empty()) {
      if (t-epoch<3) return false;
      last=cv::Mat::zeros(480,640,CV_8UC3);
    }
    // The caller is paced too; tolerate clock granularity, never catch up bursts.
    if (last_encode>=0 && t-last_encode<0.9/fps) return false;
    last_encode=t;
    bitrate=std::clamp(bitrate,250000,1500000);
    if (!codec || codec->width!=last.cols || codec->height!=last.rows ||
        std::abs(bitrate-current_bitrate)>current_bitrate/10) { open_codec(bitrate); force_keyframe=true; }
    avcheck(av_frame_make_writable(frame));
    const uint8_t *src[]={last.data}; int strides[]={static_cast<int>(last.step)};
    sws_scale(scaler,src,strides,0,last.rows,frame->data,frame->linesize);
    pts=std::max(pts+1,static_cast<int64_t>((t-epoch)*90000)); frame->pts=pts;
    frame->pict_type=force_keyframe?AV_PICTURE_TYPE_I:AV_PICTURE_TYPE_NONE;
    avcheck(avcodec_send_frame(codec,frame));
    AVPacket *packet=av_packet_alloc(); if (!packet) throw std::bad_alloc();
    int result=avcodec_receive_packet(codec,packet);
    if (result<0) { av_packet_free(&packet); avcheck(result); }
    try { output.assign(packet->data,packet->data+packet->size); key=(packet->flags&AV_PKT_FLAG_KEY)!=0; }
    catch (...) { av_packet_free(&packet); throw; }
    av_packet_free(&packet); ++encoded; return true;
  }
};
thread_local char error[1024]={};
template<class F> int checked(F f) noexcept {
  try { f(); error[0]=0; return 0; }
  catch (const std::exception &e) { std::snprintf(error,sizeof(error),"%s",e.what()); return -1; }
  catch (...) { std::snprintf(error,sizeof(error),"native preview failure"); return -1; }
}
}
extern "C" {
uint32_t ks_abi_version() noexcept { return 1; }
const char *ks_error() noexcept { return error; }
void *ks_create(const char *topic,int w,int h,int fps) noexcept {
  Engine *e=nullptr; checked([&]{if (!topic) throw std::invalid_argument("null topic"); e=new Engine(topic,w,h,fps);}); return e;
}
int ks_start(Engine *e) noexcept { return checked([&]{if (!e || e->thread.joinable()) throw std::runtime_error("invalid native start"); e->start();}); }
int ks_destroy(Engine *e) noexcept { return checked([&]{delete e;}); }
int ks_next(Engine *e,int key,int bitrate,const uint8_t **data,size_t *size,int64_t *pts,int *is_key) noexcept {
  return checked([&]{
    if (!e || !data || !size || !pts || !is_key) throw std::invalid_argument("null output");
    *size=0; *data=nullptr;
    if (e->next(key!=0,bitrate)) { *data=e->output.data(); *size=e->output.size(); *pts=e->pts; *is_key=e->key; }
  });
}
int ks_stats(Engine *e,double *fps,uint64_t *received,uint64_t *decoded,uint64_t *encoded,uint64_t *errors) noexcept {
  return checked([&]{
    if (!e || !fps || !received || !decoded || !encoded || !errors) throw std::invalid_argument("null stats");
    std::lock_guard<std::mutex> lock(e->mutex);
    if (!e->failure.empty()) throw std::runtime_error(e->failure);
    auto &a=e->arrivals; while (!a.empty() && a.front()<now_s()-2) a.pop_front();
    *fps=a.size()>1 && a.back()>a.front()?(a.size()-1)/(a.back()-a.front()):0;
    *received=e->received; *decoded=e->decoded; *encoded=e->encoded; *errors=e->errors;
  });
}
}
