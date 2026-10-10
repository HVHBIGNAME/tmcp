namespace PcMcp;

internal static class ConfirmDialog
{
    internal static bool Show(Form owner, string title, string detail, string action, bool destructive = false)
    {
        using var dialog = new Form
        {
            Text = title, Icon = Program.AppIcon, FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = false,
            StartPosition = FormStartPosition.CenterParent, ClientSize = new Size(480, 218),
            BackColor = Color.FromArgb(23, 29, 37), ForeColor = Color.FromArgb(237, 242, 247),
            Font = new Font("Segoe UI", 10), AutoScaleMode = AutoScaleMode.Dpi,
        };
        dialog.Controls.Add(new Label { Text = title, Font = new Font("Segoe UI", 15, FontStyle.Bold), AutoSize = false, Location = new Point(24, 20), Size = new Size(432, 32) });
        dialog.Controls.Add(new Label { Text = detail, AutoSize = false, Location = new Point(24, 65), Size = new Size(432, 82) });
        var confirm = new Button
        {
            Text = action, DialogResult = DialogResult.OK, FlatStyle = FlatStyle.Flat,
            BackColor = destructive ? Color.FromArgb(181, 49, 45) : Color.FromArgb(242, 177, 75),
            ForeColor = destructive ? Color.White : Color.FromArgb(36, 21, 3),
            Location = new Point(240, 164), Size = new Size(216, 38), AccessibleName = action,
        };
        confirm.FlatAppearance.BorderSize = 0;
        var cancel = new Button { Text = "Отмена", DialogResult = DialogResult.Cancel, FlatStyle = FlatStyle.Flat, Location = new Point(120, 164), Size = new Size(108, 38) };
        dialog.Controls.Add(confirm); dialog.Controls.Add(cancel);
        dialog.CancelButton = cancel;
        dialog.AcceptButton = cancel;
        return dialog.ShowDialog(owner) == DialogResult.OK;
    }
}
