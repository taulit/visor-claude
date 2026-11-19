// A window for the shell tests, with a child process below it that stands in
// for a Claude Code session started from that window. Prints the pid of the
// child, then stays until it is killed.
//
// Usage: gjs -m window.js TITLE [SECOND_TITLE]
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';

const titles = ARGV.length > 0 ? ARGV : ['Terminal'];
const app = new Gtk.Application({
  application_id: 'io.github.taulit.VisorClaude.TestWindow',
  flags: Gio.ApplicationFlags.NON_UNIQUE,
});
app.connect('activate', () => {
  for (const title of titles) {
    const window = new Gtk.ApplicationWindow({
      application: app,
      title,
      default_width: 480,
      default_height: 320,
    });
    window.present();
  }
  const child = Gio.Subprocess.new(['sleep', '100000'], Gio.SubprocessFlags.NONE);
  print(child.get_identifier());
  GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, 15, () => {
    child.force_exit();
    app.quit();
    return GLib.SOURCE_REMOVE;
  });
});
app.run([]);
