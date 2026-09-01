package logger

import (
	"io"
	"log/slog"
	"os"
	"strconv"
	"strings"

	"gopkg.in/natefinch/lumberjack.v2"
)

// Setup initializes the global slog logger based on environment variables.
// LOG_FORMAT: "json" or "text" (default: "text")
// LOG_LEVEL: "debug", "info", "warn", "error" (default: "info")
// LOG_FILE: if provided, logs will be written to this file in addition to stdout.
func Setup() {
	var handler slog.Handler

	logFormat := strings.ToLower(os.Getenv("LOG_FORMAT"))
	logLevelStr := strings.ToLower(os.Getenv("LOG_LEVEL"))
	logFile := os.Getenv("LOG_FILE")

	var level slog.Level
	switch logLevelStr {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	opts := &slog.HandlerOptions{
		Level: level,
	}

	var writer io.Writer = os.Stdout

	if logFile != "" {
		l := &lumberjack.Logger{
			Filename:   logFile,
			MaxSize:    getEnvInt("LOG_MAX_SIZE", 10),   // megabytes
			MaxBackups: getEnvInt("LOG_MAX_BACKUPS", 3), // files
			MaxAge:     getEnvInt("LOG_MAX_AGE", 28),    // days
			Compress:   true,                            // disabled by default
		}
		writer = io.MultiWriter(os.Stdout, l)
	}

	if logFormat == "json" {
		handler = slog.NewJSONHandler(writer, opts)
	} else {
		handler = slog.NewTextHandler(writer, opts)
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)
}

func getEnvInt(key string, defaultVal int) int {
	v := os.Getenv(key)
	if v == "" {
		return defaultVal
	}
	i, err := strconv.Atoi(v)
	if err != nil {
		return defaultVal
	}
	return i
}
