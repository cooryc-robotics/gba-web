/*
 * wasm_gba.c
 *
 * Wrapper de mGBA (Game Boy Advance, Game Boy y Game Boy Color, MPL-2.0)
 * para WebAssembly. Expone al
 * JavaScript funciones simples: cargar ROM, correr un frame, leer pantalla
 * y audio, botones y partida guardada. El orden de inicialización sigue el
 * del frontend libretro de mGBA.
 */

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include <mgba/core/cheats.h>
#include <mgba/core/config.h>
#include <mgba/core/core.h>
#include <mgba/gb/core.h>
#include <mgba/gba/core.h>
#include <mgba/internal/gb/input.h>
#include <mgba/internal/gba/input.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/audio-resampler.h>
#include <mgba-util/vfs.h>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

/* Búfer de vídeo con margen para la pantalla más grande (SGB con borde:
 * 256x224). Cada núcleo usa solo la parte que necesita. */
#define VIDEO_STRIDE 256
#define VIDEO_MAX_H 224
#define OUT_RATE 44100
#define SAVE_SIZE 0x20000 /* 128 KiB: el máximo de un cartucho GBA (Flash 1M) */
#define AUDIO_OUT_FRAMES 2048

static struct mCore *core = NULL;

static uint8_t *rom_buf = NULL;
static size_t rom_size = 0;

static mColor video[VIDEO_STRIDE * VIDEO_MAX_H];
static uint32_t framebuffer[VIDEO_STRIDE * VIDEO_MAX_H]; /* RGBA, compacto, para <canvas> */
static unsigned fb_w = 240, fb_h = 160;
static int is_gb = 0; /* 0 = GBA, 1 = Game Boy / Game Boy Color */

static struct mAudioBuffer audio_dest;
static struct mAudioResampler resampler;
static int16_t audio_out[AUDIO_OUT_FRAMES * 2];
static int audio_out_frames = 0;
static int audio_ready = 0;

static uint8_t savedata[SAVE_SIZE];
static uint8_t save_prev[SAVE_SIZE];

static uint32_t keys = 0;

/* Libera el juego actual (si lo hay). Hay que hacerlo ANTES de liberar el
 * buffer del ROM, porque el núcleo lo tiene mapeado. */
static void teardown(void)
{
	if (!core)
		return;
	if (audio_ready) {
		mAudioResamplerDeinit(&resampler);
		mAudioBufferDeinit(&audio_dest);
		audio_ready = 0;
	}
	core->deinit(core);
	core = NULL;
	keys = 0;
}

/* Reserva el buffer donde JS copia los bytes del .gba. Se puede llamar
 * varias veces (para cambiar de juego): limpia el anterior y deja la
 * partida guardada en blanco para que no se mezcle con la del siguiente. */
EMSCRIPTEN_KEEPALIVE
uint8_t *em_alloc_rom(uint32_t size)
{
	teardown();
	memset(savedata, 0xFF, SAVE_SIZE);
	memset(save_prev, 0xFF, SAVE_SIZE);
	free(rom_buf);
	rom_buf = malloc(size);
	rom_size = size;
	return rom_buf;
}

/* Buffer de la partida guardada (128 KiB, inicializado a 0xFF). Si JS tiene
 * una partida guardada, debe copiarla aquí ANTES de llamar a em_start(). */
EMSCRIPTEN_KEEPALIVE
uint8_t *em_get_save_ptr(void) { return savedata; }

EMSCRIPTEN_KEEPALIVE
uint32_t em_get_save_size(void) { return SAVE_SIZE; }

/* Crea el emulador con el ROM ya copiado. kind: 0 = GBA, 1 = Game Boy /
 * Game Boy Color. Devuelve 0 si todo va bien. */
EMSCRIPTEN_KEEPALIVE
int em_start(int kind)
{
	teardown();
	if (!rom_buf)
		return 1;

	is_gb = kind ? 1 : 0;
	core = is_gb ? GBCoreCreate() : GBACoreCreate();
	if (!core)
		return 2;

	mCoreInitConfig(core, NULL);
	core->init(core);
	core->setVideoBuffer(core, video, VIDEO_STRIDE);

	/* ~549 muestras por frame a 32768 Hz; margen doble. */
	core->setAudioBufferSize(core, 1024);

	mCoreConfigSetDefaultValue(&core->config, "idleOptimization", "remove");
	/* Sin esto el volumen de mGBA vale 0 y todo suena en silencio (los
	 * frontends de mGBA lo fijan siempre; 0x100 = volumen máximo). */
	mCoreConfigSetDefaultIntValue(&core->config, "volume", 0x100);
	/* Super Game Boy: sin marco, para que la pantalla sea siempre 160x144. */
	mCoreConfigSetDefaultIntValue(&core->config, "sgb.borders", 0);
	mCoreLoadConfig(core);

	struct VFile *vf = VFileFromMemory(rom_buf, rom_size);
	if (!vf || !core->loadROM(core, vf)) {
		return 3;
	}

	struct VFile *save = VFileFromMemory(savedata, SAVE_SIZE);
	if (save && !core->loadSave(core, save)) {
		save->close(save);
	}
	memcpy(save_prev, savedata, SAVE_SIZE);

	core->reset(core);
	core->currentVideoSize(core, &fb_w, &fb_h);

	/* Resampleo del audio nativo (32768 Hz) a 44100 Hz. */
	mAudioBufferInit(&audio_dest, 4096, 2);
	mAudioResamplerInit(&resampler, mINTERPOLATOR_COSINE);
	mAudioResamplerSetSource(&resampler, core->getAudioBuffer(core),
				 (double)core->audioSampleRate(core), true);
	mAudioResamplerSetDestination(&resampler, &audio_dest, (double)OUT_RATE);
	audio_ready = 1;

	keys = 0;
	return 0;
}

/* Corre un frame de vídeo y deja listo el audio de ese frame. */
EMSCRIPTEN_KEEPALIVE
void em_run_frame(void)
{
	if (!core)
		return;

	core->setKeys(core, keys);
	core->runFrame(core);

	/* Pantalla: copia compacta (fb_w x fb_h). mGBA deja el canal alfa a 0 y
	 * el canvas lo necesita a 255. */
	core->currentVideoSize(core, &fb_w, &fb_h);
	if (fb_w > VIDEO_STRIDE)
		fb_w = VIDEO_STRIDE;
	if (fb_h > VIDEO_MAX_H)
		fb_h = VIDEO_MAX_H;
	for (unsigned y = 0; y < fb_h; y++)
		for (unsigned x = 0; x < fb_w; x++)
			framebuffer[y * fb_w + x] = video[y * VIDEO_STRIDE + x] | 0xFF000000u;

	/* Audio: resamplear lo que haya salido en este frame. */
	mAudioResamplerProcess(&resampler);
	size_t n = mAudioBufferRead(&audio_dest, audio_out, AUDIO_OUT_FRAMES);
	audio_out_frames = (int)n;
}

/* Pantalla: em_fb_width() x em_fb_height() píxeles RGBA (bytes R,G,B,A),
 * listo para ImageData. 240x160 en GBA, 160x144 en GB/GBC. */
EMSCRIPTEN_KEEPALIVE
uint32_t *em_get_framebuffer(void) { return framebuffer; }

EMSCRIPTEN_KEEPALIVE
int em_fb_width(void) { return (int)fb_w; }

EMSCRIPTEN_KEEPALIVE
int em_fb_height(void) { return (int)fb_h; }

/* Audio: int16 estéreo intercalado a 44100 Hz. Devuelve nº de frames
 * (pares L/R) disponibles tras el último em_run_frame(). */
EMSCRIPTEN_KEEPALIVE
int16_t *em_get_audio_buffer(void) { return audio_out; }

EMSCRIPTEN_KEEPALIVE
int em_get_audio_frames(void) { return audio_out_frames; }

/* Botones: 0=A 1=B 2=SELECT 3=START 4=RIGHT 5=LEFT 6=UP 7=DOWN 8=R 9=L
 * (R y L solo existen en GBA). */
EMSCRIPTEN_KEEPALIVE
void em_set_button(int button, int pressed)
{
	static const int map[10] = {
		GBA_KEY_A, GBA_KEY_B, GBA_KEY_SELECT, GBA_KEY_START,
		GBA_KEY_RIGHT, GBA_KEY_LEFT, GBA_KEY_UP, GBA_KEY_DOWN,
		GBA_KEY_R, GBA_KEY_L
	};
	if (button < 0 || button > 9)
		return;
	if (is_gb && button > 7)
		return;
	uint32_t bit = 1u << (is_gb ? button : map[button]);
	if (pressed)
		keys |= bit;
	else
		keys &= ~bit;
}

/* Devuelve 1 si el juego ha modificado la partida guardada desde la última
 * vez que se preguntó (así JS solo guarda cuando hace falta). */
EMSCRIPTEN_KEEPALIVE
int em_save_changed(void)
{
	if (memcmp(savedata, save_prev, SAVE_SIZE) == 0)
		return 0;
	memcpy(save_prev, savedata, SAVE_SIZE);
	return 1;
}

/* Detiene el juego actual (para volver al menú). */
EMSCRIPTEN_KEEPALIVE
void em_stop(void) { teardown(); }

/* ---- Estados rápidos ----
 * em_state_buffer() reserva (o reutiliza) un búfer del tamaño de un estado
 * del juego actual. em_save_state() lo rellena y devuelve su tamaño;
 * em_load_state() carga el estado que JS haya copiado en él. */

static uint8_t *state_buf = NULL;
static size_t state_buf_size = 0;

EMSCRIPTEN_KEEPALIVE
uint8_t *em_state_buffer(void)
{
	if (!core)
		return NULL;
	size_t size = core->stateSize(core);
	if (size > state_buf_size) {
		free(state_buf);
		state_buf = malloc(size);
		state_buf_size = state_buf ? size : 0;
	}
	return state_buf;
}

EMSCRIPTEN_KEEPALIVE
uint32_t em_state_size(void) { return core ? (uint32_t)core->stateSize(core) : 0; }

EMSCRIPTEN_KEEPALIVE
uint32_t em_save_state(void)
{
	if (!em_state_buffer() || !core->saveState(core, state_buf))
		return 0;
	return (uint32_t)core->stateSize(core);
}

EMSCRIPTEN_KEEPALIVE
int em_load_state(void)
{
	if (!core || !state_buf || state_buf_size < core->stateSize(core))
		return 0;
	return core->loadState(core, state_buf) ? 1 : 0;
}

/* ---- Trucos (GameShark, Action Replay, CodeBreaker, Game Genie) ----
 * JS escribe los códigos en em_cheat_text() (una línea por código, texto
 * terminado en 0) y llama a em_cheats_apply(), que sustituye los trucos
 * activos. Devuelve cuántas líneas se aceptaron. */

#define CHEAT_TEXT_SIZE 16384
static char cheat_text[CHEAT_TEXT_SIZE];

EMSCRIPTEN_KEEPALIVE
char *em_cheat_text(void) { return cheat_text; }

EMSCRIPTEN_KEEPALIVE
uint32_t em_cheat_text_size(void) { return CHEAT_TEXT_SIZE; }

EMSCRIPTEN_KEEPALIVE
int em_cheats_apply(void)
{
	if (!core)
		return 0;
	struct mCheatDevice *device = core->cheatDevice(core);
	if (!device)
		return 0;
	mCheatDeviceClear(device);

	cheat_text[CHEAT_TEXT_SIZE - 1] = '\0';
	struct mCheatSet *set = device->createSet(device, NULL);
	int accepted = 0;
	char *line = cheat_text;
	while (line && *line) {
		char *next = strchr(line, '\n');
		if (next)
			*next++ = '\0';
		/* Autodetecta el formato (0 = *_CHEAT_AUTODETECT en GBA y GB). */
		if (*line && mCheatAddLine(set, line, 0))
			accepted++;
		line = next;
	}
	if (accepted)
		mCheatAddSet(device, set);
	else
		mCheatSetDeinit(set); /* también libera el set */
	return accepted;
}
